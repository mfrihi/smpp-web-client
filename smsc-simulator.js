/**
 * SMSC Simulator — SMPP v3.4 test server
 * Listens on port 2775, accepts any bind, echoes submit_sm
 * Supports: bind (TX/RX/TRX), unbind, enquire_link, submit_sm, 
 *           deliver_sm (DLR injection), replace_sm, cancel_sm, 
 *           data coding overrides, custom message_id
 * 
 * Usage: node smsc-simulator.js [port]
 *   Default port: 2775
 *   Custom:       node smsc-simulator.js 2776
 */
const smpp = require('smpp');
const readline = require('readline');

const PORT = parseInt(process.argv[2]) || 2775;

// ── In-memory message store ──────────────────────────────────────────────
const messages = new Map();   // message_id -> { ...submit_sm fields }
let seqCounter = 1;

function nextSeq() { return seqCounter++; }

// ── Colour helpers ───────────────────────────────────────────────────────
const colours = {
  reset:  '\x1b[0m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  dim:    '\x1b[2m',
};

function log(label, msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`${colours.dim}[${t}]${colours.reset} ${label} ${msg}`);
}
function ok(msg)  { log(`${colours.green}▶${colours.reset}`, msg); }
function info(msg){ log(`${colours.cyan}ℹ${colours.reset}`,  msg); }
function warn(msg){ log(`${colours.yellow}⚠${colours.reset}`, msg); }
function err(msg) { log(`${colours.red}✘${colours.reset}`,  msg); }

// ── Helper: Extract short_message from a PDU ─────────────────────────────
function getMessageText(pdu) {
  return pdu.short_message
    ? (Buffer.isBuffer(pdu.short_message) ? pdu.short_message.toString('utf8') : pdu.short_message)
    : '';
}

// ── Helper: Send a DLR back to the bound session ─────────────────────────
function sendDlr(session, origMsgId, origDest) {
  const dlrMsgId = `DLR_${origMsgId}`;
  // Construct a deliver_sm with DLR payload
  const dlrPayload = `id:${origMsgId} sub:001 dlvrd:001 submit date:${new Date().toISOString().slice(0,10)} done date:${new Date().toISOString().slice(0,10)} stat:DELIVRD err:000 text:..........`;
  
  session.deliver_sm({
    source_addr: origDest || 'SMSC',
    destination_addr: 'TEST',
    esm_class: 0x04,                    // DLR
    data_coding: 0,
    short_message: dlrPayload,
    registered_delivery: 0,
    sequence_number: nextSeq(),
  }, (pdu) => {
    if (pdu.command_status === 0) {
      ok(`DLR sent for message ${colours.yellow}${origMsgId}${colours.green}`);
    } else {
      warn(`DLR rejected by session: command_status=${pdu.command_status}`);
    }
  });
}

// ── Create the server ────────────────────────────────────────────────────
const server = smpp.createServer({}, (session) => {
  const remote = `${session.socket.remoteAddress || 'unknown'}:${session.socket.remotePort || '?'}`;
  info(`New connection from ${remote}`);

  // Track bound state per session
  let boundSystemId = null;
  let boundMode = null;
  let boundSourceAddr = null;
  let boundTon = 1;
  let boundNpi = 1;

  // ── BIND handlers ────────────────────────────────────────────────────
  session.on('bind_transceiver', (pdu) => {
    boundSystemId = pdu.system_id.toString('utf8') || 'unknown';
    boundMode = 'transceiver';
    boundSourceAddr = pdu.system_id.toString('utf8');
    bindSuccess(session, pdu);
  });

  session.on('bind_transmitter', (pdu) => {
    boundSystemId = pdu.system_id.toString('utf8') || 'unknown';
    boundMode = 'transmitter';
    boundSourceAddr = pdu.system_id.toString('utf8');
    bindSuccess(session, pdu);
  });

  session.on('bind_receiver', (pdu) => {
    boundSystemId = pdu.system_id.toString('utf8') || 'unknown';
    boundMode = 'receiver';
    boundSourceAddr = pdu.system_id.toString('utf8');
    bindSuccess(session, pdu);
  });

  function bindSuccess(session, pdu) {
    session.send(pdu.response({
      system_id: 'SMSC_SIM',
      sc_interface_version: 0x34,       // SMPP v3.4
    }));
    ok(`Bound as ${colours.cyan}${boundMode}${colours.reset} — system_id: ${colours.yellow}${boundSystemId}${colours.reset}`);
  }

  // ── UNBIND ───────────────────────────────────────────────────────────
  session.on('unbind', (pdu) => {
    session.send(pdu.response());
    ok(`Unbound: ${boundSystemId}`);
    boundSystemId = null;
    boundMode = null;
    setTimeout(() => session.close(), 100);
  });

  // ── ENQUIRE_LINK ─────────────────────────────────────────────────────
  session.on('enquire_link', (pdu) => {
    session.send(pdu.response());
  });

  // ── SUBMIT_SM ────────────────────────────────────────────────────────
  session.on('submit_sm', (pdu) => {
    const msgId = `MSG_${String(messages.size + 1).padStart(4, '0')}`;
    const text = getMessageText(pdu);
    const dest = pdu.destination_addr ? pdu.destination_addr.toString() : '';
    
    // Store the message for later operations
    messages.set(msgId, {
      destination_addr: dest,
      short_message: text,
      source_addr: pdu.source_addr ? pdu.source_addr.toString() : '',
      data_coding: pdu.data_coding,
      registered_delivery: pdu.registered_delivery,
      timestamp: new Date(),
      status: 'QUEUED',
      session: session,  // Track which session submitted it
    });

    // Send submit_sm_resp
    session.send(pdu.response({
      message_id: msgId,
    }));

    ok(`submit_sm → ${colours.yellow}${msgId}${colours.reset} → ${colours.dim}${dest}${colours.reset} (${messages.size} stored)`);

    // If registered_delivery was requested, send a DLR after 2 seconds
    if (pdu.registered_delivery && pdu.registered_delivery > 0) {
      setTimeout(() => {
        messages.set(msgId, { ...messages.get(msgId), status: 'DELIVERED' });
        sendDlr(session, msgId, dest);
      }, 2000);
    } else {
      // Auto-deliver after 1s
      setTimeout(() => {
        messages.set(msgId, { ...messages.get(msgId), status: 'DELIVERED' });
      }, 1000);
    }
  });

  // ── REPLACE_SM ───────────────────────────────────────────────────────
  session.on('replace_sm', (pdu) => {
    const msgId = pdu.message_id ? pdu.message_id.toString() : '';
    const msg = messages.get(msgId);
    
    if (!msg) {
      err(`replace_sm: message_id ${msgId} not found`);
      session.send(pdu.response({ command_status: 0x1D })); // ESME_RINVMSGID
      return;
    }
    if (msg.status === 'DELIVERED') {
      err(`replace_sm: message ${msgId} already delivered`);
      session.send(pdu.response({ command_status: 0x21 })); // ESME_RINVEXPIRY
      return;
    }

    const newText = getMessageText(pdu);
    msg.short_message = newText;
    messages.set(msgId, msg);
    
    session.send(pdu.response());
    ok(`replace_sm → ${colours.yellow}${msgId}${colours.reset}: "${newText.substring(0, 40)}..."`);
  });

  // ── CANCEL_SM ───────────────────────────────────────────────────────
  session.on('cancel_sm', (pdu) => {
    const msgId = pdu.message_id ? pdu.message_id.toString() : '';
    const msg = messages.get(msgId);
    
    if (!msg) {
      err(`cancel_sm: message_id ${msgId} not found`);
      session.send(pdu.response({ command_status: 0x1D })); // ESME_RINVMSGID
      return;
    }
    if (msg.status === 'DELIVERED') {
      err(`cancel_sm: message ${msgId} already delivered`);
      session.send(pdu.response({ command_status: 0x21 })); // ESME_RINVEXPIRY
      return;
    }

    msg.status = 'CANCELLED';
    messages.set(msgId, msg);
    
    session.send(pdu.response());
    ok(`cancel_sm → ${colours.yellow}${msgId}${colours.reset} (CANCELLED)`);
  });

  // ── DELIVER_SM_RESP (incoming DLR acknowledgement) ───────────────────
  session.on('deliver_sm_resp', (pdu) => {
    if (pdu.command_status === 0) {
      // DLR acknowledged by client
    }
  });

  // ── SESSION CLOSE ────────────────────────────────────────────────────
  session.on('close', () => {
    if (boundSystemId) {
      info(`Session closed: ${boundSystemId} (${boundMode})`);
    } else {
      info(`Session closed (not bound): ${remote}`);
    }
  });

  session.on('error', (e) => {
    err(`Session error: ${e.message}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${colours.green}╔══════════════════════════════════════════════════════╗${colours.reset}`);
  console.log(`${colours.green}║${colours.reset}           SMSC Simulator — SMPP v3.4              ${colours.green}║${colours.reset}`);
  console.log(`${colours.green}║${colours.reset}                                                  ${colours.green}║${colours.reset}`);
  console.log(`${colours.green}║${colours.reset}  Listening on  ${colours.cyan}0.0.0.0:${PORT}${colours.reset}                   ${colours.green}║${colours.reset}`);
  console.log(`${colours.green}║${colours.reset}  Accepting any bind (TX/RX/TRX)                 ${colours.green}║${colours.reset}`);
  console.log(`${colours.green}║${colours.reset}  DLR auto-sent 2s after submit_sm (if requested) ${colours.green}║${colours.reset}`);
  console.log(`${colours.green}║${colours.reset}  Messages stored: ${colours.yellow}in-memory${colours.reset} (static after start)    ${colours.green}║${colours.reset}`);
  console.log(`${colours.green}╚══════════════════════════════════════════════════════╝${colours.reset}\n`);
  info(`Ready for SMPP connections on port ${PORT}\n`);
});

server.on('error', (e) => {
  err(`Server error: ${e.message}`);
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ${colours.red}Port ${PORT} is already in use. Try:${colours.reset}`);
    console.error(`  ${colours.cyan}  node smsc-simulator.js ${PORT + 1}${colours.reset}\n`);
    process.exit(1);
  }
});
