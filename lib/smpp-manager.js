'use strict';

const smpp = require('smpp');
const { EventEmitter } = require('events');

// Build a reverse lookup for SMPP command status codes: code → name
const esmeNames = {};
if (smpp.errors) {
  for (const [name, val] of Object.entries(smpp.errors)) {
    if (typeof val === 'number') {
      esmeNames[val] = name;
    }
  }
}
function lookupEsmeName(code) {
  // Standard SMPP v3.4 codes from smpp.errors
  if (esmeNames[code]) return esmeNames[code];
  // Common vendor-specific / SMSC error codes
  const vendorCodes = {
    104: 'ESME_RSUBMITFAIL (104 / 0x68) — Vendor-specific: source not whitelisted, destination not routed, or account permission issue',
  };
  return vendorCodes[code] || `unknown (${code})`;
}

/**
 * SMPP Manager — high-level SMPP protocol handler
 *
 * Handles connection lifecycle, message submission (single & batch),
 * message replacement / cancellation, inbound SMS / DLR parsing,
 * GSM-7 / UCS-2 encoding detection and splitting, windowed flow
 * control, and automatic ENQUIRE_LINK keepalives.
 *
 * @fires SmppManager#status
 * @fires SmppManager#message_sent
 * @fires SmppManager#message_replaced
 * @fires SmppManager#message_cancelled
 * @fires SmppManager#incoming_sms
 * @fires SmppManager#dlr_received
 * @fires SmppManager#batch_progress
 * @fires SmppManager#error
 * @fires SmppManager#log
 */
class SmppManager extends EventEmitter {

  // ---------------------------------------------------------------------------
  // Constants & helpers
  // ---------------------------------------------------------------------------

  /** GSM 7-bit default alphabet characters */
  static get GSM7_CHARS() {
    return '@£$¥èéùìòÇ\\nØø\\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  }

  /** Characters only available via the GSM 7-bit extension table (0x1B prefix) */
  static get GSM7_EXT_CHARS() {
    return '\\^{}\\[~\\]|€';
  }

  /**
   * Pack GSM-7 text into 7-bit packed bytes (GSM 03.38).
   * Each character becomes a 7-bit value, packed LSB-first into 8-bit bytes.
   * Extension characters (^, {}, etc.) are prefixed with 0x1B ESC.
   *
   * @param {string} text - GSM-7 text
   * @returns {Buffer} 7-bit packed bytes
   */
  static _gsm7Pack(text) {
    const coder = smpp.gsmCoder.getCoder();
    const codes = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let code = coder.charListEnc[ch];
      if (code === undefined) {
        code = coder.extCharListEnc[ch];
        if (code !== undefined) {
          codes.push(0x1B);
          codes.push(code);
          continue;
        }
        code = 0x3F; // fallback to '?'
      }
      codes.push(code);
    }
    // Pack 7-bit codes into 8-bit bytes (LSB first)
    const packed = [];
    let bitPos = 0;
    let current = 0;
    for (let i = 0; i < codes.length; i++) {
      current |= (codes[i] & 0x7F) << bitPos;
      bitPos += 7;
      if (bitPos >= 8) {
        packed.push(current & 0xFF);
        current >>= 8;
        bitPos -= 8;
      }
    }
    if (bitPos > 0) packed.push(current & 0xFF);
    return Buffer.from(packed);
  }

  /** Maximum sequence number (SMPP uses 4-byte unsigned integer) */
  static get MAX_SEQUENCE() {
    return 0x7FFFFFFF;
  }

  /** Default ENQUIRE_LINK interval (ms) */
  static get ENQUIRE_INTERVAL() {
    return 30000;
  }

  /** Default window size (outstanding messages) */
  static get DEFAULT_WINDOW() {
    return 10;
  }

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor() {
    super();

    /** @type {smpp.Session|null} */
    this.session = null;

    /** @type {boolean} */
    this.isConnected = false;

    /** @type {string|null} 'transceiver' | 'transmitter' | 'receiver' | null */
    this.bindMode = null;

    /** @type {number} sequential PDU sequence number */
    this.sequenceNumber = 1;

    /**
     * Map<number, {resolve, reject, timestamp}>
     * Maps sequence numbers to pending submission promises.
     */
    this.pendingMessages = new Map();

    /** @type {NodeJS.Timeout|null} */
    this.enquireLinkTimer = null;

    /** @type {number} max outstanding messages before we block */
    this.windowSize = SmppManager.DEFAULT_WINDOW;

    /** @type {number} current outstanding message count */
    this.outstandingCount = 0;

    /** @type {object|null} connection configuration */
    this.config = null;

    /** @type {Array<object>} accumulated incoming messages */
    this.incomingMsgs = [];

    /**
     * Batch progress tracker.
     * @type {{ total: number, completed: number, current: number, results: Array }}
     */
    this.batchProgress = { total: 0, completed: 0, current: 0, results: [] };
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  /**
   * Connect and bind to the SMSC.
   *
   * @param {object} config
   * @param {string} config.host          SMSC hostname / IP
   * @param {number} config.port          SMSC port (usually 2775)
   * @param {string} config.system_id     username
   * @param {string} config.password      password
   * @param {string} [config.system_type]  optional system type
   * @param {number} [config.window_size]  override default window size
   * @returns {Promise<void>}
   * @throws {Error} on timeouts or bind rejections
   */
  async connect(config) {
    return new Promise((resolve, reject) => {
      try {
        const { host, port, system_id, password, system_type, bind_mode } = config;

        if (!host || !port || !system_id || !password) {
          return reject(new Error('Missing required connection parameters (host, port, system_id, password)'));
        }

        this.config = config;

        if (config.window_size && typeof config.window_size === 'number') {
          this.windowSize = config.window_size;
        }

        this.emit('status', { state: 'connecting', host, port });

        const session = smpp.connect({ host, port });
        session.setMaxListeners(0); // Allow dynamic PDU listeners without warning

        session.on('connect', () => {
          this.emit('log', { level: 'info', message: `TCP connected to ${host}:${port}` });

          const bindParams = {
            system_id,
            password,
            system_type: system_type || '',
            interface_version: 0x34,
          };

          const bm = (bind_mode || 'transceiver').toLowerCase();
          if (bm === 'transmitter') {
            session.bind_transmitter(bindParams);
          } else if (bm === 'receiver') {
            session.bind_receiver(bindParams);
          } else {
            session.bind_transceiver(bindParams);
          }
        });

        session.on('error', (err) => {
          if (!this.isConnected) {
            reject(err);
          }
          this.emit('error', { message: 'Session error', error: err.message });
          this.emit('log', { level: 'error', message: `Session error: ${err.message}` });
        });

        session.on('close', () => {
          const wasConnected = this.isConnected;
          this.isConnected = false;
          this._stopEnquireLinkTimer();
          this.emit('status', { state: 'disconnected' });
          this.emit('log', { level: 'warn', message: 'Session closed' });

          if (!wasConnected) {
            // Never got a bind_resp — reject the pending connect promise
            reject(new Error('Connection closed before bind response'));
          }
        });

        // Handle PDU responses — we need to look at every PDU to wire
        // submit_sm_resp back to pending promises.
        session.on('pdu', (pdu) => {
          const cmd = pdu.command;

          if (cmd === 'bind_transceiver_resp' || cmd === 'bind_transmitter_resp' || cmd === 'bind_receiver_resp') {
            if (pdu.command_status === 0) {
              this.session = session;
              this.isConnected = true;
              // Extract bind mode from response command
              if (cmd === 'bind_transmitter_resp') {
                this.bindMode = 'transmitter';
                this.emit('status', { state: 'connected', bindMode: 'transmitter' });
                this.emit('log', { level: 'info', message: 'Successfully bound as transmitter' });
              } else if (cmd === 'bind_receiver_resp') {
                this.bindMode = 'receiver';
                this.emit('status', { state: 'connected', bindMode: 'receiver' });
                this.emit('log', { level: 'info', message: 'Successfully bound as receiver' });
              } else {
                this.bindMode = 'transceiver';
                this.emit('status', { state: 'connected', bindMode: 'transceiver' });
                this.emit('log', { level: 'info', message: 'Successfully bound as transceiver' });
              }
              this._bindSMPPEvents();
              this._startEnquireLinkTimer();
              resolve();
            } else {
              const errMsg = lookupEsmeName(pdu.command_status);
              session.close();
              reject(new Error(`Bind failed: ${errMsg}`));
            }
            return;
          }

          // If not connected yet, ignore stray PDUs
          if (!this.isConnected) return;

          // ------------------- submit_sm_resp -------------------
          // (Handled entirely by the submit_sm() callback — skip here to avoid double-resolution.
          // The callback in sendMessage owns the Promise lifecycle for submit_sm.)
          if (cmd === 'submit_sm_resp') {
            return;
          }

          // ------------------- deliver_sm (inbound SMS / DLR) -------------------
          if (cmd === 'deliver_sm') {
            this._handleDeliverSm(pdu);
            return;
          }

          // ------------------- enquire_link_resp -------------------
          if (cmd === 'enquire_link_resp') {
            // Nothing to do — keepalive acknowledged
            return;
          }

          // ------------------- generic_nack -------------------
          if (cmd === 'generic_nack') {
            this.emit('error', {
              message: 'Generic NACK received',
              command_status: pdu.command_status,
              sequence_number: pdu.sequence_number,
            });

            // Resolve / reject the pending message if one exists for this seq
            const seq = pdu.sequence_number;
            const pending = this.pendingMessages.get(seq);
            if (pending) {
              this.pendingMessages.delete(seq);
              this.outstandingCount = Math.max(0, this.outstandingCount - 1);
              pending.reject(new Error(
                `Generic NACK (status ${pdu.command_status})`
              ));
            }
            return;
          }

          // ------------------- unbind_resp -------------------
          if (cmd === 'unbind_resp') {
            this.emit('log', { level: 'info', message: 'Unbind acknowledged' });
            return;
          }
        });

      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Gracefully disconnect from the SMSC.
   *
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (!this.session || !this.isConnected) {
      this.emit('log', { level: 'warn', message: 'disconnect() called but not connected' });
      return;
    }

    return new Promise((resolve) => {
      this._stopEnquireLinkTimer();

      const timeout = setTimeout(() => {
        this.emit('log', { level: 'warn', message: 'Unbind timed out — forcing close' });
        this._cleanup();
        resolve();
      }, 10000);

      // Listen for close before unbinding so we don't miss it
      const onClose = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.session.once('close', onClose);

      try {
        this.session.unbind();
        this.session.close();
      } catch (err) {
        clearTimeout(timeout);
        this._cleanup();
        resolve();
      }
    });
  }

  /**
   * Return a human-readable connection status string.
   *
   * @returns {string}
   */
  getStatus() {
    if (!this.isConnected) return 'disconnected';
    return `connected (${this.bindMode || 'unknown'})`;
  }

  /**
   * Send a single SMS.
   *
   * @param {object} params  — see _buildSubmitSm for full parameter list
   * @returns {Promise<{message_id: string, sequence_number: number}>}
   */
  async sendMessage(params) {
    if (!this.session || !this.isConnected) {
      throw new Error('Not connected to SMSC');
    }

    // --- Windowing ---
    if (this.outstandingCount >= this.windowSize) {
      throw new Error(`Window full (${this.outstandingCount}/${this.windowSize})`);
    }

    // --- Detect encoding ONCE from the full message ---
    // This ensures ALL segments use the same data_coding.
    // Without this, each segment in a split message re-detects encoding
    // independently, causing segments with only ASCII chars to get
    // data_coding=0 (GSM-7) while segments with non-GSM-7 chars get
    // data_coding=8 (UCS-2). The SMSC rejects inconsistent encodings
    // across concatenated segments with vendor-specific errors (e.g. 118).
    const userDc = params.data_coding !== undefined ? Number(params.data_coding) : 0;
    const forcedDataCoding = (userDc !== 0) ? userDc : this._detectEncoding(params.short_message).data_coding;
    console.log('[sendMessage] forcedDataCoding=' + forcedDataCoding + ' (userDc=' + userDc + ') msg_len=' + params.short_message.length);

    // --- Check for multi-segment (UDH split) ---
    var segTexts = [params.short_message];
    var segUdhs = [null];

    // Try splitting via _buildSubmitSm first — it truncates to 1 segment
    // We'll re-do the split here to send all segments.
    // Force the detected encoding so the split uses correct per-segment limits.
    const pdu = this._buildSubmitSm(
      Object.assign({}, params, { data_coding: forcedDataCoding }),
      this._getNextSequenceNumber()
    );
    const hasUdh = pdu._segments && pdu._segments.length > 1;

    if (hasUdh) {
      segTexts = pdu._segments.map(function(s) { return s.text; });
      segUdhs = pdu._segments.map(function(s) { return s.udh; });
    }

    // Force data_coding on every segment so _buildSubmitSm does NOT
    // re-detect per-segment encoding.
    const baseSegParams = Object.assign({}, params, { data_coding: forcedDataCoding });

    // --- Send all segments sequentially ---
    const results = [];
    for (var si = 0; si < segTexts.length; si++) {
      const segSeq = this._getNextSequenceNumber();
      const segPdu = this._buildSubmitSm(
        Object.assign({}, baseSegParams, { short_message: segTexts[si] }),
        segSeq
      );
      // Apply UDH if present for this segment
      if (segUdhs[si]) {
        segPdu.esm_class = 0x40;
        // Encode text with correct encoding for the data_coding.
        // When data_coding=8 (UCS-2), text must be 2 bytes/char big-endian.
        // Buffer.from(text) uses UTF-8 (1 byte for ASCII) which the SMSC
        // misinterprets when it expects UCS-2 — silently drops the message.
        // When data_coding=0 (GSM-7 default): we use ASCII (data_coding=1)
        // with raw 8-bit bytes instead of 7-bit packing. This matches how
        // the smpp library's native encode filter handles UDH messages and
        // is the most widely compatible approach. The _splitMessage already
        // calculates per-segment limits for ASCII (135 chars/segment).
        const dc = segPdu.data_coding !== undefined ? Number(segPdu.data_coding) : 0;
        let textBuffer;
        if (dc === 8) {
          textBuffer = Buffer.from(segTexts[si], 'ucs2').swap16(); // UCS-2 BE
        } else {
          // Use raw bytes (8-bit) for all non-UCS-2 encodings.
          // The smpp library stores GSM-7 and ASCII text as plain 8-bit bytes,
          // NOT 7-bit packed. The SMSC/phone handles GSM-7 alphabet decoding
          // based on data_coding. 7-bit packing would produce bits that the
          // phone misinterprets as raw bytes, causing scrambled text.
          textBuffer = Buffer.from(segTexts[si]);
        }
        segPdu.short_message = Buffer.concat([
          Buffer.from(segUdhs[si]),
          textBuffer
        ]);
      }
      // Apply SAR TLVs if present (instead of UDH)
      if (pdu._segments && pdu._segments[si] && pdu._segments[si].sar) {
        const s = pdu._segments[si].sar;
        segPdu.sar_msg_ref_num = s.ref;
        segPdu.sar_total_segments = s.total;
        segPdu.sar_segment_seqnum = s.seq;
        // Ensure esm_class does NOT have UDHI bit for SAR
        if (segPdu.esm_class === 0x40) segPdu.esm_class = 0x00;
      }

      // Send this segment and wait for response
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingMessages.delete(segSeq);
          this.outstandingCount = Math.max(0, this.outstandingCount - 1);
          reject(new Error('Submit_sm timeout for sequence ' + segSeq));
        }, 120000);

        this.pendingMessages.set(segSeq, {
          resolve: (r) => { clearTimeout(timeout); resolve(r); },
          reject: (e) => { clearTimeout(timeout); reject(e); },
          timestamp: Date.now(),
        });

        this.outstandingCount += 1;
        console.log('[PDU] submit_sm:', JSON.stringify({
          source_addr: segPdu.source_addr,
          source_addr_ton: segPdu.source_addr_ton,
          source_addr_npi: segPdu.source_addr_npi,
          destination_addr: segPdu.destination_addr,
          dest_addr_ton: segPdu.destination_addr_ton,
          dest_addr_npi: segPdu.destination_addr_npi,
          data_coding: segPdu.data_coding,
          esm_class: segPdu.esm_class,
          registered_delivery: segPdu.registered_delivery,
          priority_flag: segPdu.priority_flag,
          msg_length: (segPdu.short_message || '').length,
          msg_payload_len: segPdu.message_payload ? segPdu.message_payload.length : 0,
          has_udh: segPdu.esm_class === 0x40,
          has_sar: segPdu.sar_msg_ref_num !== undefined,
          sar_ref: segPdu.sar_msg_ref_num,
          sar_total: segPdu.sar_total_segments,
          sar_seq: segPdu.sar_segment_seqnum,
          seq: segSeq,
        }));
        this.session.submit_sm(segPdu, (resp) => {
          const pending = this.pendingMessages.get(resp.sequence_number);
          if (!pending) return;
          this.pendingMessages.delete(resp.sequence_number);
          this.outstandingCount = Math.max(0, this.outstandingCount - 1);
          clearTimeout(timeout);

          if (resp.command_status === 0) {
            this.emit('message_sent', {
              sequence_number: resp.sequence_number,
              destination: params.destination_addr,
              message_id: resp.message_id,
              segment: si + 1,
              total_segments: segTexts.length,
            });
            pending.resolve({
              message_id: resp.message_id,
              sequence_number: resp.sequence_number,
              segment: si + 1,
              total_segments: segTexts.length,
            });
          } else {
            const errMsg = 'Submit error ' + resp.command_status + ' (' + lookupEsmeName(resp.command_status) + ')';
            // Dump full PDU for debugging vendor-specific errors
            const respKeys = Object.keys(resp).filter(k => k !== '_pdu');
            this.emit('log', { level: 'error', message: '[PDU_RESP] submit_sm_resp: ' + JSON.stringify({ command_status: resp.command_status, message_id: resp.message_id, extra: respKeys }) });
            pending.reject(new Error(errMsg));
          }
        });
      });

      results.push(result);
    }

    // Return first message_id for backwards compat, but include all results
    return results[0] || { message_id: null, sequence_number: null };
  }

  /**
   * Replace an existing message on the SMSC.
   *
   * @param {object} params
   * @param {string} params.message_id
   * @param {string} params.source_addr
   * @param {number} [params.source_addr_ton]
   * @param {number} [params.source_addr_npi]
   * @param {string} params.new_message
   * @returns {Promise<void>}
   */
  async replaceMessage(params) {
    if (!this.session || !this.isConnected) {
      throw new Error('Not connected to SMSC');
    }

    const { message_id, source_addr, source_addr_ton, source_addr_npi, new_message } = params;

    if (!message_id || !new_message) {
      throw new Error('replaceMessage requires message_id and new_message');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('replace_sm timeout'));
      }, 30000);

      const onResp = (pdu) => {
        if (pdu.command === 'replace_sm_resp') {
          this.session.removeListener('pdu', onResp);
          clearTimeout(timeout);

          if (pdu.command_status === 0) {
            this.emit('message_replaced', { message_id, source_addr });
            this.emit('log', {
              level: 'info',
              message: `Message ${message_id} replaced`,
            });
            resolve();
          } else {
            const errMsg = lookupEsmeName(pdu.command_status);
            reject(new Error(errMsg));
          }
        }
      };

      this.session.on('pdu', onResp);

      this.session.replace_sm({
        message_id,
        source_addr,
        source_addr_ton: source_addr_ton || 0x01, // International
        source_addr_npi: source_addr_npi || 0x01, // ISDN
        short_message: new_message,
      });
    });
  }

  /**
   * Cancel a pending message on the SMSC.
   *
   * @param {object} params
   * @param {string} params.message_id
   * @param {string} [params.source_addr]
   * @param {string} [params.destination_addr]
   * @returns {Promise<void>}
   */
  async cancelMessage(params) {
    if (!this.session || !this.isConnected) {
      throw new Error('Not connected to SMSC');
    }

    const { cancel_by, message_id, source_addr, destination_addr } = params;

    if (cancel_by !== 'source_dest' && !message_id) {
      throw new Error('cancelMessage requires message_id (or cancel_by=source_dest with source_addr+destination_addr)');
    }

    // No need to build cancelParams — use params directly in cancel_sm()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('cancel_sm timeout'));
      }, 30000);

      const onResp = (pdu) => {
        if (pdu.command === 'cancel_sm_resp') {
          this.session.removeListener('pdu', onResp);
          clearTimeout(timeout);

          if (pdu.command_status === 0) {
            this.emit('message_cancelled', { message_id, source_addr, destination_addr });
            this.emit('log', {
              level: 'info',
              message: `Message ${message_id || '(by source+dest)'} cancelled`,
            });
            resolve();
          } else {
            const errMsg = lookupEsmeName(pdu.command_status);
            reject(new Error(errMsg));
          }
        }
      };

      this.session.on('pdu', onResp);

      this.session.cancel_sm({
        ...(params.message_id ? { message_id: params.message_id } : {}),
        ...(params.source_addr ? { source_addr: params.source_addr } : {}),
        ...(params.destination_addr ? { destination_addr: params.destination_addr } : {}),
      });
    });
  }

  /**
   * Send the same message body to multiple destinations.
   * Emits 'batch_progress' events periodically.
   *
   * @param {object} params
   * @param {Array<string>} params.destinations  phone numbers
   * @param {string} params.message              message text
   * @param {object} [params.baseParams]          additional params to pass to sendMessage
   * @returns {Promise<Array>}  results per destination
   */
  async sendBatch(params) {
    const { destinations, message, baseParams = {} } = params;

    if (!destinations || !Array.isArray(destinations) || destinations.length === 0) {
      throw new Error('sendBatch requires a non-empty destinations array');
    }

    if (!message) {
      throw new Error('sendBatch requires a message');
    }

    const total = destinations.length;
    const results = [];

    this.batchProgress = { total, completed: 0, current: 0, results };
    this.emit('batch_progress', { ...this.batchProgress, phase: 'start' });
    this.emit('log', { level: 'info', message: `Starting batch send to ${total} destinations` });

    let windowErrors = 0;
    const maxWindowErrors = 3;

    for (let i = 0; i < total; i++) {
      const destination = destinations[i];
      this.batchProgress.current = i + 1;

      // Wait for window to have capacity
      await this._waitForWindow();

      const entry = { destination, sequence_number: null, message_id: null, error: null };

      try {
        const sendParams = {
          ...baseParams,
          destination_addr: destination,
          short_message: message,
        };

        const result = await this.sendMessage(sendParams);
        entry.sequence_number = result.sequence_number;
        entry.message_id = result.message_id;
        windowErrors = 0; // Reset on success
      } catch (err) {
        entry.error = err.message;
        windowErrors += 1;
        this.emit('error', {
          message: `Batch send failed for ${destination}`,
          error: err.message,
          destination,
        });
      }

      results.push(entry);
      this.batchProgress.completed = i + 1;
      this.batchProgress.results = results;

      // Emit progress periodically (every 10 items or at the end)
      if ((i + 1) % 10 === 0 || i === total - 1) {
        this.emit('batch_progress', {
          total,
          completed: i + 1,
          current: i + 1,
          results,
          phase: 'progress',
        });
      }

      // Abort if too many consecutive window-full errors
      if (windowErrors >= maxWindowErrors) {
        this.emit('error', {
          message: `Batch aborted after ${maxWindowErrors} consecutive window-full errors`,
          completed: i + 1,
          total,
        });
        this.emit('log', { level: 'error', message: 'Batch aborted — too many window errors' });
        break;
      }
    }

    this.emit('batch_progress', {
      total,
      completed: this.batchProgress.completed,
      current: total,
      results,
      phase: 'complete',
    });

    this.emit('log', {
      level: 'info',
      message: `Batch completed: ${this.batchProgress.completed}/${total} sent`,
    });

    return results;
  }

  // ---------------------------------------------------------------------------
  // Inbound message / DLR handling
  // ---------------------------------------------------------------------------

  /**
   * Handle an incoming deliver_sm PDU.
   *
   * @param {object} pdu
   * @private
   */
  _handleDeliverSm(pdu) {
    const sourceAddr = pdu.source_addr ? pdu.source_addr.toString() : '';
    const destAddr = pdu.destination_addr ? pdu.destination_addr.toString() : '';
    const esmClass = pdu.esm_class || 0;
    const dc = pdu.data_coding !== undefined ? pdu.data_coding : 0;

    // Decode the message payload
    let messageText = '';

    if (pdu.short_message) {
      // short_message can be a Buffer, string, or object with a .message key
      const raw = pdu.short_message;
      if (typeof raw === 'string') {
        messageText = this._decodeMessage(raw, dc);
      } else if (Buffer.isBuffer(raw)) {
        messageText = this._decodeMessage(raw, dc);
      } else if (raw.message) {
        // e.g. {message: "id:abc... stat:DELIVRD ..."}
        messageText = String(raw.message);
      } else if (Array.isArray(raw) || raw instanceof Uint8Array || raw instanceof Int8Array) {
        // smpp library sometimes stores short_message as an array of octets
        messageText = this._decodeMessage(Buffer.from(raw), dc);
      } else if (typeof raw === 'object' && raw.type === 'Buffer') {
        // {type: 'Buffer', data: [...]} deserialized form
        messageText = this._decodeMessage(Buffer.from(raw.data), dc);
      } else if (typeof raw.toString === 'function' && raw.toString() !== '[object Object]') {
        messageText = this._decodeMessage(Buffer.from(String(raw)), dc);
      } else {
        // Last resort: try JSON to see if there's meaningful data
        try { messageText = JSON.stringify(raw); } catch (_) { messageText = String(raw); }
      }
    }

    // --- DLR detection ---
    // ESM class 0x04 indicates a delivery receipt (SME Delivery Acknowledgment)
    const isDLR = (esmClass & 0x04) !== 0 && /^id:/i.test(messageText.trim());

    if (isDLR) {
      try {
        const dlr = this._parseDLR(messageText);
        // In SMPP, deliver_sm source_addr = MSISDN (who generated the receipt),
        // destination_addr = ESME (who receives the DLR). We swap for UI clarity:
        // source = original sender, destination = original receiver.
        dlr.source_addr = destAddr;
        dlr.destination_addr = sourceAddr;
        dlr.received_at = new Date().toISOString();

        this.incomingMsgs.push({ type: 'dlr', ...dlr });
        this.emit('dlr_received', dlr);
        this.emit('log', {
          level: 'info',
          message: `DLR received for ${dlr.message_id}: ${dlr.status}`,
        });
      } catch (err) {
        this.emit('error', {
          message: 'Failed to parse DLR',
          error: err.message,
          raw: messageText,
        });
      }
    } else {
      // --- Incoming SMS ---
      const incoming = {
        source_addr: sourceAddr,
        destination_addr: destAddr,
        message: messageText,
        data_coding: dc,
        esm_class: esmClass,
        received_at: new Date().toISOString(),
        ...(pdu.schedule_delivery_time ? { schedule_delivery_time: pdu.schedule_delivery_time.toString() } : {}),
        ...(pdu.validity_period ? { validity_period: pdu.validity_period.toString() } : {}),
      };

      // Extract TLVs if present
      const tlvTags = [
        'receipted_message_id',
        'message_state',
        'network_error_code',
        'source_subaddress',
        'dest_subaddress',
        'user_message_reference',
      ];

      for (const tag of tlvTags) {
        if (pdu[tag] !== undefined) {
          incoming[tag] = pdu[tag];
        }
      }

      this.incomingMsgs.push({ type: 'sms', ...incoming });
      this.emit('incoming_sms', incoming);
      this.emit('log', {
        level: 'info',
        message: `Incoming SMS from ${sourceAddr} (${messageText.length} chars)`,
      });
    }

    // Respond with deliver_sm_resp
    try {
      const resp = new smpp.PDU('deliver_sm_resp', {
        sequence_number: pdu.sequence_number,
        command_status: 0,
      });
      if (this.session && this.session.socket && this.session.socket.writable) {
        this.session.send(resp);
      }
    } catch (err) {
      this.emit('error', {
        message: 'Failed to send deliver_sm_resp',
        error: err.message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Encoding detection
  // ---------------------------------------------------------------------------

  /**
   * Detect the optimal SMS encoding for a given text.
   *
   * @param {string} text
   * @returns {{ encoding: string, data_coding: number, maxChars: number, reason: string }}
   */
  _detectEncoding(text) {
    // Check for Emoji (U+1F300–U+1F9FF range)
    const emojiRegex = /[\u{1F300}-\u{1F9FF}]/u;
    if (emojiRegex.test(text)) {
      return {
        encoding: 'UCS-2',
        data_coding: 0x08,
        maxChars: 67,
        reason: 'emoji detected',
      };
    }

    // Check for Arabic script (U+0600–U+06FF)
    const arabicRegex = /[\u0600-\u06FF]/;
    if (arabicRegex.test(text)) {
      return {
        encoding: 'UCS-2',
        data_coding: 0x08,
        maxChars: 67,
        reason: 'Arabic characters detected',
      };
    }

    // Check for any other non-GSM-7 character (including Unicode supplementary)
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      const ch = text[i];

      // Skip GSM-7 basic set
      if (SmppManager.GSM7_CHARS.includes(ch)) continue;

      // Skip GSM-7 extension set (single-char extension)
      if (SmppManager.GSM7_EXT_CHARS.includes(ch)) continue;

      // Anything else requires UCS-2
      return {
        encoding: 'UCS-2',
        data_coding: 0x08,
        maxChars: 67,
        reason: `non-GSM-7 character U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
      };
    }

    // Check for characters that need extension table (reduce per-segment capacity)
    let hasExt = false;
    for (const ch of text) {
      if (SmppManager.GSM7_EXT_CHARS.includes(ch)) {
        hasExt = true;
        break;
      }
    }

    if (hasExt) {
      return {
        encoding: 'GSM-7',
        data_coding: 0x00,
        maxChars: 152, // 153 minus 1 for extension table overhead
        reason: 'GSM-7 with extension characters',
      };
    }

    return {
      encoding: 'GSM-7',
      data_coding: 0x00,
      maxChars: 153,
      reason: 'pure GSM-7',
    };
  }

  // ---------------------------------------------------------------------------
  // DLR parsing
  // ---------------------------------------------------------------------------

  /**
   * Parse an SMPP delivery receipt string.
   *
   * Expected format:
   *   id:IIIIIIIIII sub:SSS dlvrd:DDD submit date:YYMMDDhhmm done date:YYMMDDhhmm stat:DDDDD err:EEE
   *
   * @param {string} str  raw DLR text
   * @returns {{ message_id: string, submitted_count: number, delivered_count: number, status: string, status_name: string, status_color: string }}
   */
  _parseDLR(str) {
    const fields = {};

    // Split by whitespace and parse key:value pairs
    const parts = str.trim().split(/\s+/);
    for (const part of parts) {
      const idx = part.indexOf(':');
      if (idx === -1) continue;
      const key = part.substring(0, idx).toLowerCase();
      const value = part.substring(idx + 1);
      fields[key] = value;
    }

    const messageId = fields.id || '';

    // Parse numeric fields
    const submittedCount = fields.sub !== undefined ? parseInt(fields.sub, 10) : 0;
    const deliveredCount = fields.dlvrd !== undefined ? parseInt(fields.dlvrd, 10) : 0;

    // Parse status
    const rawStatus = (fields.stat || '').toUpperCase();

    // Map status codes to human-readable names and colours
    const statusMap = {
      'DELIVRD': { name: 'Delivered', color: 'green' },
      'EXPIRED': { name: 'Expired', color: 'orange' },
      'DELETED': { name: 'Deleted', color: 'orange' },
      'UNDELIV': { name: 'Undelivered', color: 'red' },
      'ACCEPTD': { name: 'Accepted', color: 'green' },
      'UNKNOWN': { name: 'Unknown', color: 'yellow' },
      'REJECTD': { name: 'Rejected', color: 'red' },
      'SKIPPED': { name: 'Skipped', color: 'yellow' },
    };

    const statusInfo = statusMap[rawStatus] || { name: rawStatus, color: 'grey' };

    return {
      message_id: messageId,
      submitted_count: isNaN(submittedCount) ? 0 : submittedCount,
      delivered_count: isNaN(deliveredCount) ? 0 : deliveredCount,
      status: rawStatus,
      status_name: statusInfo.name,
      status_color: statusInfo.color,
    };
  }

  // ---------------------------------------------------------------------------
  // Message decoding
  // ---------------------------------------------------------------------------

  /**
   * Decode a message payload buffer into a string based on data coding scheme.
   *
   * @param {Buffer} buf  raw short_message bytes
   * @param {number} dc   SMPP data_coding value
   * @returns {string}
   */
  _decodeMessage(buf, dc) {
    if (!Buffer.isBuffer(buf)) {
      return buf ? buf.toString() : '';
    }

    if (buf.length === 0) return '';

    switch (dc) {
      case 0x00: // GSM 7-bit default alphabet
        try {
          // Try smpp.gsm_decode if available
          if (typeof smpp.gsm_decode === 'function') {
            return smpp.gsm_decode(buf);
          }
        } catch (_) {
          // Fall through to manual decode
        }
        return this._gsm7Decode(buf);

      case 0x01: // ASCII
        return buf.toString('ascii').replace(/\0+$/, '');

      case 0x02: // Latin-1
        return buf.toString('latin1').replace(/\0+$/, '');

      case 0x03: // Binary
        return buf.toString('hex').toUpperCase();

      case 0x04: // 8-bit
        return buf.toString('binary');

      case 0x08: // UCS-2 (UTF-16 BE)
        return buf.toString('ucs2').replace(/\0+$/, '');

      default:
        // Attempt UCS-2 as default; fall back to Latin-1
        try {
          return buf.toString('ucs2').replace(/\0+$/, '');
        } catch (_) {
          return buf.toString('latin1').replace(/\0+$/, '');
        }
    }
  }

  /**
   * Manually decode a GSM 7-bit packed buffer to a string.
   *
   * @param {Buffer} buf
   * @returns {string}
   * @private
   */
  _gsm7Decode(buf) {
    const basic = SmppManager.GSM7_CHARS;
    const ext = SmppManager.GSM7_EXT_CHARS;
    let result = '';
    let carry = 0;

    for (let i = 0; i < buf.length; i++) {
      const byte = buf[i];
      const septet = ((byte << (7 - (i % 7))) | carry) & 0x7F;
      carry = byte >> (i % 7);

      // Process septets only when we have a full one (every 7 bytes produce 8 septets)
      if (i % 7 === 0 && i > 0) {
        // The carry from the previous byte is now a full septet
      }

      const idx = (i % 7 === 0 && i > 0) ? -1 : i % 7;
    }

    // Simpler approach: use unpack algorithm
    // 7-bit GSM characters are packed into 8-bit bytes
    let bitPos = 0;
    let current = 0;
    let bitsInCurrent = 0;

    for (let i = 0; i < buf.length; i++) {
      current = (current << 8) | buf[i];
      bitsInCurrent += 8;

      while (bitsInCurrent >= 7) {
        bitsInCurrent -= 7;
        const septet = (current >> bitsInCurrent) & 0x7F;

        if (septet === 0x1B) {
          // Extension character follows
          if (bitsInCurrent >= 7) {
            bitsInCurrent -= 7;
            const extIdx = (current >> bitsInCurrent) & 0x7F;
            if (extIdx >= 0 && extIdx < ext.length) {
              result += ext[extIdx];
            }
          }
        } else if (septet < basic.length) {
          result += basic[septet];
        }
      }
    }

    // Remove GSM padding characters (0x00 = '@')
    result = result.replace(/@+$/, '');

    return result;
  }

  // ---------------------------------------------------------------------------
  // Message splitting (concatenated SMS)
  // ---------------------------------------------------------------------------

  /**
   * Split a message into segments for concatenated SMS.
   *
   * @param {string} msg         the full message
   * @param {number} dc          data coding value
   * @param {number} [maxSegments=3]  max allowed segments
   * @returns {Array<{udh: Buffer, text: string}>}
   */
  // ---- _splitMessage is defined below near previewSplit ----

  // ---------------------------------------------------------------------------
  // Submit SM PDU builder
  // ---------------------------------------------------------------------------

  /**
   * Build a full submit_sm PDU object.
   *
   * @param {object} params
   * @param {string} params.source_addr
   * @param {number} [params.source_addr_ton=0x01]
   * @param {number} [params.source_addr_npi=0x01]
   * @param {string} params.destination_addr
   * @param {number} [params.destination_addr_ton=0x01]
   * @param {number} [params.destination_addr_npi=0x01]
   * @param {string} params.short_message  text body
   * @param {number} [params.data_coding]  auto-detected if omitted
   * @param {number} [params.esm_class=0x00]
   * @param {number} [params.protocol_id=0x00]
   * @param {number} [params.priority_flag=0x00]
   * @param {string} [params.schedule_delivery_time]
   * @param {string} [params.validity_period]
   * @param {string} [params.service_type='']
   * @param {number} [params.replace_if_present_flag=0x00]
   * @param {number} [params.sm_default_msg_id=0x00]
   * @param {number} [params.registered_delivery=0x00]
   * @param {number} [params.sequence_number]
   * @returns {object} a PDU-compatible object
   */
  _buildSubmitSm(params, seqOverride) {
    const {
      source_addr,
      source_addr_ton: rawSrcTon,
      source_addr_npi: rawSrcNpi,
      destination_addr,
      dest_addr_ton: rawDestTon,          // From GUI defaults (dest_ prefix)
      destination_addr_ton = rawDestTon,  // Prefer destination_, fallback to dest_
      dest_addr_npi: rawDestNpi,          // From GUI defaults (dest_ prefix)
      destination_addr_npi = rawDestNpi,  // Prefer destination_, fallback to dest_
      short_message,
      data_coding: explicitDc,
      esm_class: rawEsm,
      protocol_id: rawPid,
      priority_flag: rawPriority,
      schedule_delivery_time,
      validity_period,
      service_type = '',
      replace_if_present_flag: rawReplace,
      sm_default_msg_id: rawDefMsg,
      registered_delivery: rawRegDlv,
    } = params;

    if (!source_addr || !destination_addr || !short_message) {
      throw new Error('_buildSubmitSm requires source_addr, destination_addr, and short_message');
    }

    // Normalize: convert all SMPP numeric fields from potential strings to numbers
    // (HTML select/input elements return strings; the SMPP library needs numbers)
    const srcTon   = rawSrcTon !== undefined ? Number(rawSrcTon) : 1;
    const srcNpi   = rawSrcNpi !== undefined ? Number(rawSrcNpi) : 1;
    const destTon  = destination_addr_ton !== undefined ? Number(destination_addr_ton) : 1;
    const destNpi  = destination_addr_npi !== undefined ? Number(destination_addr_npi) : 1;
    const esmClass = rawEsm !== undefined ? Number(rawEsm) : 0;
    const pid      = rawPid !== undefined ? Number(rawPid) : 0;
    const priority = rawPriority !== undefined ? Number(rawPriority) : 0;
    const regDlv   = rawRegDlv !== undefined ? Number(rawRegDlv) : 0;
    const replFlag = rawReplace !== undefined ? Number(rawReplace) : 0;
    const defMsg   = rawDefMsg !== undefined ? Number(rawDefMsg) : 0;
    // data_coding is used separately — normalize here for dcWithClass mapping
    const normDc   = explicitDc !== undefined ? Number(explicitDc) : undefined;

    // Auto-detect encoding
    const encoding = this._detectEncoding(short_message);
    // Use auto-detected encoding UNLESS user explicitly chose a non-default encoding.
    // data_coding=0 (GSM-7) is the defaults panel default — let auto-detect override it.
    // data_coding=1,3,4,8 (ASCII, Latin-1, Binary, UCS-2) are active user choices.
    const dataCoding = (normDc !== undefined && normDc !== 0) ? normDc : encoding.data_coding;

    // Apply message class (Flash/SIM/TE) to data_coding bits 4-5 per SMPP v3.4 §6.3
    // Class 0 (Flash) = 0x10, Class 1 (Normal) = 0x00, Class 2 (SIM) = 0x20, Class 3 (TE) = 0x30
    const msgClass = params.message_class !== undefined ? Number(params.message_class) : 1;
    let dcWithClass = dataCoding;
    if (dataCoding <= 0x08) { // Only apply to GSM-7/ASCII/Latin-1/UCS-2/Binary base
      if (msgClass === 0) dcWithClass = (dataCoding & 0x0F) | 0x10;  // Flash
      else if (msgClass === 2) dcWithClass = (dataCoding & 0x0F) | 0x20;  // SIM
      else if (msgClass === 3) dcWithClass = (dataCoding & 0x0F) | 0x30;  // TE
      // Class 1 (Normal) — leave as-is
    }

    // Respect split_mode from params
    let splitMode = params.split_mode || 'auto';

    // Determine split method: 'udh' or 'sar'
    let splitMethod = 'udh';
    if (splitMode === 'sar') splitMethod = 'sar';
    else if (splitMode === 'udh') splitMethod = 'udh';

    // Split if needed (long messages) — only if not 'none'
    let messageText = short_message;
    let udh = null;
    let splitSegments = null;
    const maxSingleLen = dataCoding === 0x08 ? 70 : (dataCoding === 3 ? 140 : 160);

    if (short_message.length > maxSingleLen && splitMode !== 'none') {
      const splitResult = this._splitMessage(short_message, dataCoding, 10, '8bit', splitMethod);
      const segments = splitResult.segments || [];

      if (segments.length > 0) {
        messageText = segments[0].text;
        udh = segments[0].udh;
        splitSegments = segments;
      }
    }

    const pdu = {
      source_addr,
      source_addr_ton: srcTon,
      source_addr_npi: srcNpi,
      destination_addr,
      destination_addr_ton: destTon,
      destination_addr_npi: destNpi,
      short_message: messageText,
      data_coding: dcWithClass,
      esm_class: udh ? 0x40 : esmClass, // UDHI bit if UDH present
      protocol_id: pid,
      priority_flag: priority,
      replace_if_present_flag: replFlag,
      sm_default_msg_id: defMsg,
      registered_delivery: regDlv,
      sequence_number: seqOverride || this._getNextSequenceNumber(),
      // Only include optional fields when they have a value
      ...(service_type ? { service_type } : {}),
      ...(schedule_delivery_time ? { schedule_delivery_time } : {}),
      ...(validity_period ? { validity_period } : {}),
    };

    // When split_mode is 'none': send as a single PDU with no splitting.
    // Message goes in short_message (≤ 254 bytes). If larger, use the
    // message_payload TLV (tag 0x0424) per SMPP v3.4 §5.2.4 standard.
    if (splitMode === 'none') {
      if (Buffer.byteLength(short_message, 'utf8') > 254) {
        pdu.message_payload = short_message;
        pdu.short_message = '';
      }
      // else: pdu.short_message is already set to messageText above
    }

    // For binary SMS with data_coding 4, if data > 254 bytes, use message_payload TLV
    if (dataCoding === 4 && messageText && Buffer.byteLength(messageText, 'utf8') > 254) {
      // Already handled above if splitMode === 'none', but also handle auto-split binary
      if (splitMode !== 'none') {
        pdu.message_payload = messageText;
        pdu.short_message = '';
      }
      // Add application port TLVs if specified
      if (params.source_port !== undefined) {
        pdu.source_port = Number(params.source_port);
      }
      if (params.destination_port !== undefined) {
        pdu.destination_port = Number(params.destination_port);
      }
    }

    // Attach segment info for multi-part handling in sendMessage()
    if (splitSegments && splitSegments.length > 0) {
      pdu._segments = splitSegments;
    }

    return pdu;
  }

  // ---------------------------------------------------------------------------
  // Sequence number management
  // ---------------------------------------------------------------------------

  /**
   * Get the next monotonic sequence number, wrapping at 0x7FFFFFFF.
   *
   * @returns {number}
   * @private
   */
  _getNextSequenceNumber() {
    const seq = this.sequenceNumber;
    this.sequenceNumber = (this.sequenceNumber % SmppManager.MAX_SEQUENCE) + 1;
    return seq;
  }

  // ---------------------------------------------------------------------------
  // ENQUIRE_LINK keepalive
  // ---------------------------------------------------------------------------

  /**
   * Start sending periodic ENQUIRE_LINK PDUs.
   *
   * @private
   */
  _startEnquireLinkTimer() {
    this._stopEnquireLinkTimer();
    this.enquireLinkTimer = setInterval(() => {
      if (this.session && this.isConnected) {
        try {
          this.session.enquire_link();
          this.emit('log', { level: 'debug', message: 'ENQUIRE_LINK sent' });
        } catch (err) {
          this.emit('error', {
            message: 'Failed to send ENQUIRE_LINK',
            error: err.message,
          });
        }
      }
    }, SmppManager.ENQUIRE_INTERVAL);

    this.enquireLinkTimer.unref();
  }

  /**
   * Stop the ENQUIRE_LINK timer.
   *
   * @private
   */
  _stopEnquireLinkTimer() {
    if (this.enquireLinkTimer) {
      clearInterval(this.enquireLinkTimer);
      this.enquireLinkTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // SMPP session event wiring
  // ---------------------------------------------------------------------------

  /**
   * Bind SMPP session-level event handlers.
   * The `pdu` handler is already wired in connect().
   *
   * @private
   */
  _bindSMPPEvents() {
    if (!this.session) return;

    this.session.on('close', () => {
      const wasConnected = this.isConnected;
      this.isConnected = false;
      this._stopEnquireLinkTimer();
      this.emit('status', { state: 'disconnected' });
      this.emit('log', { level: 'warn', message: 'SMPP session closed' });

      // Reject all pending messages
      if (wasConnected) {
        for (const [seq, pending] of this.pendingMessages) {
          pending.reject(new Error('Connection closed'));
          this.pendingMessages.delete(seq);
        }
        this.outstandingCount = 0;
      }
    });

    this.session.on('error', (err) => {
      this.emit('error', { message: 'SMPP session error', error: err.message });
      this.emit('log', { level: 'error', message: `SMPP error: ${err.message}` });
    });
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Wait until the send window has capacity.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _waitForWindow() {
    while (this.outstandingCount >= this.windowSize) {
      await new Promise((resolve) => {
        // Poll every 50ms for window space
        const check = setInterval(() => {
          if (this.outstandingCount < this.windowSize) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });
    }
  }

  /**
   * Clean up all resources (used during disconnect).
   *
   * @private
   */
  _cleanup() {
    this._stopEnquireLinkTimer();
    this.isConnected = false;
    this.bindMode = null;

    // Reject any pending messages
    for (const [seq, pending] of this.pendingMessages) {
      pending.reject(new Error('Disconnected'));
    }
    this.pendingMessages.clear();
    this.outstandingCount = 0;

    if (this.session) {
      try {
        this.session.close();
      } catch (_) {
        // Ignore errors during cleanup
      }
      this.session = null;
    }
  }

  // ---------------------------------------------------------------------------
  // UDH / Message Concatenation (Split Mode)
  // ---------------------------------------------------------------------------
  _buildUDH(refNum, totalSeg, segNum, format) {
    format = format || '8bit';
    if (format === '16bit')
      // [UDHL=6] [IEI=0x00] [IEDL=0x04] [refHi] [refLo] [total] [seq]
      return [0x06, 0x00, 0x04, (refNum >> 8) & 0xFF, refNum & 0xFF, totalSeg, segNum];
    // [UDHL=5] [IEI=0x00] [IEDL=0x03] [ref] [total] [seq]
    return [0x05, 0x00, 0x03, refNum & 0xFF, totalSeg, segNum];
  }
  _udhOverhead(udhFormat) {
    return (udhFormat || '8bit') === '16bit' ? 7 : 6;
  }
  _getSegmentLimits(dc, udhLen) {
    udhLen = udhLen || 0;
    switch (dc) {
      // ASCII/8-bit: max payload is 140 bytes, each char = 1 byte
      case 1: return { maxSingle: 160, maxWithUDH: 140 - udhLen };
      // Latin-1: same as ASCII, 1 byte per char
      case 3: return { maxSingle: 140, maxWithUDH: 140 - udhLen };
      // UCS-2: 2 bytes per char
      case 8: return { maxSingle: 70, maxWithUDH: Math.floor((140 - udhLen) / 2) };
      // GSM-7 default: uses raw 8-bit bytes (same as ASCII).
      // The smpp library stores text as plain bytes (not 7-bit packed);
      // the SMSC/phone converts to GSM-7 alphabet based on data_coding.
      default:
        return { maxSingle: 160, maxWithUDH: 140 - udhLen };
    }
  }
  _splitMessage(message, dc, maxSegments, udhFormat, method) {
    dc = dc || 0;
    maxSegments = maxSegments || 10;
    udhFormat = udhFormat || '8bit';
    method = method || 'udh';
    const isSar = method === 'sar';

    if (isSar) {
      // SAR TLV split — no UDH, full segment capacity, ESM stays normal
      const limits = this._getSegmentLimits(dc, 0);
      const cps = limits.maxWithUDH || limits.maxSingle; // full char limit (no UDH)
      const totalSegments = Math.ceil(message.length / cps);
      if (maxSegments > 0 && totalSegments > maxSegments)
        throw new Error('Message requires ' + totalSegments + ' segments but max is ' + maxSegments);
      const refNum = Math.floor(Math.random() * 65535) + 1; // 16-bit ref
      const segments = [];
      for (let i = 0; i < totalSegments; i++) {
        const end = Math.min((i + 1) * cps, message.length);
        segments.push({
          num: i + 1,
          text: message.substring(i * cps, end),
          length: message.substring(i * cps, end).length,
          udh: null,
          sar: { ref: refNum, total: totalSegments, seq: i + 1 },
        });
      }
      return { segments, totalSegments, refNum, method: 'sar' };
    }

    const udhLen = this._udhOverhead(udhFormat);
    const cps = this._getSegmentLimits(dc, udhLen).maxWithUDH;
    const totalSegments = Math.ceil(message.length / cps);
    if (maxSegments > 0 && totalSegments > maxSegments)
      throw new Error('Message requires ' + totalSegments + ' segments but max is ' + maxSegments);
    const refNum = Math.floor(Math.random() * 255) + 1;
    const segments = [];
    for (let i = 0; i < totalSegments; i++) {
      const end = Math.min((i + 1) * cps, message.length);
      segments.push({
        num: i + 1,
        text: message.substring(i * cps, end),
        length: message.substring(i * cps, end).length,
        udh: this._buildUDH(refNum, totalSegments, i + 1, udhFormat),
      });
    }
    return { segments, totalSegments, refNum };
  }
  previewSplit(p) {
    if (!p || !p.message) return { segments: 0, totalChars: 0, error: 'No message' };
    // Auto-detect encoding when data_coding is 0 (same as sendMessage logic)
    const rawDc = p.data_coding !== undefined ? p.data_coding : 0;
    const dc = (rawDc !== 0) ? rawDc : this._detectEncoding(p.message).data_coding;
    const limits = this._getSegmentLimits(dc, 0);
    const totalChars = p.message.length;
    if (p.split_mode === 'none') {
      if (totalChars > limits.maxSingle)
        return { segments: 0, totalChars, maxPerSegment: limits.maxSingle,
          error: 'Message too long (' + totalChars + ' chars)' };
      return { segments: 1, totalChars, maxPerSegment: limits.maxSingle,
        segmentDetails: [{ num: 1, length: totalChars }] };
    }
    if (p.split_mode === 'manual') {
      const lines = p.message.split('\n').filter(function(l) { return l.length > 0; });
      if (lines.length === 0) return { segments: 0, totalChars: 0, error: 'No segment content' };
      return { segments: lines.length, totalChars, maxPerSegment: 0,
        segmentDetails: lines.map(function(t, i) { return { num: i + 1, length: t.length }; }) };
    }
    if (p.split_mode === 'sar') {
      // Preview SAR split — full char per segment, no UDH
      const cps = limits.maxWithUDH || limits.maxSingle;
      const totalSegments = Math.ceil(totalChars / cps);
      if (totalSegments > (p.max_segments || 10))
        return { segments: 0, totalChars, maxPerSegment: cps, error: 'Requires ' + totalSegments + ' segments, max ' + (p.max_segments || 10) };
      return { segments: totalSegments, totalChars, maxPerSegment: cps, method: 'sar',
        segmentDetails: Array.from({length: totalSegments}, function(_, i) {
          const start = i * cps;
          const end = Math.min(start + cps, totalChars);
          return { num: i + 1, length: end - start };
        }) };
    }
    try {
      const r = this._splitMessage(p.message, dc, p.max_segments || 10, p.udh_format || '8bit', p.split_mode);
      return { segments: r.totalSegments, totalChars,
        maxPerSegment: r.segments[0] ? r.segments[0].length : 0,
        segmentDetails: r.segments.map(function(s) { return { num: s.num, length: s.length }; }),
        refNum: r.refNum };
    } catch (e) {
      return { segments: 0, totalChars, error: e.message };
    }
  }

}

module.exports = SmppManager;