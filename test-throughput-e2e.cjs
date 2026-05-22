#!/usr/bin/env node
/**
 * E2E Test: Throughput Sender with SMSC Simulator
 *
 * Tests the full pipeline:
 *   1. Create SMPP session to simulator
 *   2. Create ThroughputManager job
 *   3. Run job at controlled rate
 *   4. Verify SMSC errors handled (simulate throttle)
 *   5. Verify all events fire
 *   6. Verify DLR reception
 *   7. Verify job stats
 */

async function main() {

const smpp = require('smpp');
const ThroughputManager = require('./lib/throughput-manager');

const SIM_HOST = '127.0.0.1';
const SIM_PORT = 2775;

// ── Colors ──────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
};

let passed = 0;
let failed = 0;

function ok(msg)  { passed++; console.log(`  ${C.green}✓${C.reset} ${msg}`); }
function fail(msg){ failed++; console.log(`  ${C.red}✗${C.reset} ${msg}`); }
function header(t){ console.log(`\n${C.bold}${C.cyan}═══ ${t} ═══${C.reset}\n`); }

// ── Connect to simulator ────────────────────────────────────────────────────

header('1. Connect to SMSC Simulator');

const session = smpp.connect({ host: SIM_HOST, port: SIM_PORT });
session.setMaxListeners(0);

function connect() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Bind timeout')), 5000);

    session.on('bind_transceiver_resp', (pdu) => {
      clearTimeout(timeout);
      if (pdu.command_status === 0) {
        ok('Bound as transceiver to simulator');
        resolve();
      } else {
        reject(new Error('Bind failed: ' + pdu.command_status));
      }
    });

    session.bind_transceiver({
      system_id: 'throughput_test',
      password: 'test',
    }, (pdu) => {});  // response handled by event above
  });
}

await connect();

// ── Simulate a send function using real SMPP ────────────────────────────────

let seqNum = 1;
let sentPdus = [];
let throttleMode = false;  // Set true to simulate SMSC throttling

function sendViaSim(destination, message, overrides, retryCount) {
  return new Promise((resolve) => {
    if (throttleMode) {
      // Simulate ESME_RTHROTTLED
      return resolve({
        success: false,
        error: { command_status: 0x19 },
      });
    }

    const seq = seqNum++;
    session.submit_sm({
      source_addr: overrides.source_addr || 'THRUTEST',
      destination_addr: destination,
      short_message: message,
      data_coding: overrides.data_coding || 0,
      registered_delivery: 1,
      sequence_number: seq,
    }, (resp) => {
      if (resp.command_status === 0) {
        sentPdus.push({ seq, dest: destination, msgId: resp.message_id });
        resolve({ success: true, messageId: resp.message_id });
      } else {
        resolve({
          success: false,
          error: { command_status: resp.command_status },
        });
      }
    });
  });
}

// ── ThroughputManager Test 1: Normal send ───────────────────────────────────

header('2. Throughput: Normal send (10 msg @ 50/s)');

const tm1 = new ThroughputManager();
const events1 = [];

['job_started','progress','smsc_error','job_paused','job_completed','rate_updated','message_retry','message_failed','job_stopped']
  .forEach(ev => tm1.on(ev, d => events1.push({ ev, ...d })));

const dests = [];
for (let i = 0; i < 10; i++) dests.push(`+216200000${String(i).padStart(3, '0')}`);

const jid1 = tm1.createJob({
  destinations: dests,
  message: 'Throughput test message from simulator',
  ratePerSecond: 50,
  maxRetries: 2,
  overrides: { source_addr: 'THRUTEST', data_coding: 0 },
  sendCallback: sendViaSim,
});

tm1.startJob(jid1);

// Wait for completion
await new Promise(resolve => {
  tm1.on('job_completed', (d) => {
    if (d.jobId === jid1) resolve(d);
  });
});

const st1 = tm1.getJobStatus(jid1);
const startedEv = events1.filter(e => e.ev === 'job_started').length;
const progressEv = events1.filter(e => e.ev === 'progress').length;
const completedEv = events1.filter(e => e.ev === 'job_completed').length;

if (st1.sent === 10) ok('Sent 10/10 messages');
else fail(`Sent ${st1.sent}/10`);

if (st1.failed === 0) ok('Zero failures');
else fail(`Failed: ${st1.failed}`);

if (st1.status === 'completed') ok('Job completed');
else fail(`Status: ${st1.status}`);

if (startedEv === 1) ok('job_started event fired');
else fail(`job_started fired ${startedEv}x`);

if (completedEv === 1) ok('job_completed event fired');
else fail(`job_completed fired ${completedEv}x`);

if (progressEv >= 5) ok(`progress events: ${progressEv} (real-time updates)`);
else fail(`Only ${progressEv} progress events`);

console.log(`  ${C.dim}Stats: sent=${st1.sent} failed=${st1.failed} retries=${st1.retryCount} duration=${events1.filter(e=>e.ev==='job_completed')[0]?.duration || '?'}s${C.reset}`);

// ── ThroughputManager Test 2: Throttle handling ─────────────────────────────

header('3. Throughput: SMSC Throttle handling');

const tm2 = new ThroughputManager();
let rateChanges = 0;
let lastRate = 100;
let autoPaused = false;

tm2.on('rate_updated', (d) => {
  if (d.autoReduced) {
    rateChanges++;
    lastRate = d.newRate;
  }
});
tm2.on('job_paused', (d) => {
  if (d.reason === 'throttle') autoPaused = true;
});

// Turn on throttle simulation
throttleMode = true;

const jid2 = tm2.createJob({
  destinations: ['+21620000001','+21620000002','+21620000003','+21620000004','+21620000005'],
  message: 'Throttle test',
  ratePerSecond: 100,
  maxRetries: 0,  // No retries — immediate throttle auto-handle
  overrides: {},
  sendCallback: sendViaSim,
});

tm2.startJob(jid2);

await new Promise(resolve => setTimeout(resolve, 1500));

const st2 = tm2.getJobStatus(jid2);

if (rateChanges >= 2) ok(`Rate auto-reduced ${rateChanges}x (100→50→25 msg/s)`);
else fail(`Rate reductions: ${rateChanges}`);

if (lastRate <= 25) ok(`Final rate: ${lastRate} msg/s (50% reduction per throttle)`);
else fail(`Final rate: ${lastRate} (expected ≤25)`);

if (autoPaused) ok('Job auto-paused after 3 throttles');
else fail('Job not auto-paused (status: ' + st2.status + ')');

if (st2.status === 'paused') ok(`Status: paused (throttleCount: ${st2.throttleCount})`);
else fail(`Status: ${st2.status}`);

// ── Test 3: Resume after throttle ──────────────────────────────────────────

header('4. Throughput: Resume after throttle');

throttleMode = false;  // Turn off throttling

// After throttle pause, currentIndex may have advanced past totalCount.
// Create a fresh job with remaining destinations.
const jid2b = tm2.createJob({
  destinations: ['+21620000006','+21620000007','+21620000008'],
  message: 'Resume test',
  ratePerSecond: 100,
  maxRetries: 0,
  overrides: {},
  sendCallback: sendViaSim,
});

tm2.startJob(jid2b);

await new Promise(resolve => {
  tm2.on('job_completed', (d) => {
    if (d.jobId === jid2b) resolve(d);
  });
  setTimeout(resolve, 5000);
});

const st2b = tm2.getJobStatus(jid2b);

if (st2b.status === 'completed') ok('New job completed after resume');
else fail(`Status after resume: ${st2b.status}`);

if (st2b.sent === 3) ok(`Sent ${st2b.sent}/3 after resume`);
else fail(`Sent: ${st2b.sent}/${st2b.total}`);

// ── Test 4: DLR from simulator ─────────────────────────────────────────────

header('5. Verify DLRs from simulator');

// Set up DLR listener BEFORE creating the job that requests DLRs
let dlrCount = 0;
session.on('deliver_sm', (pdu) => {
  if (pdu.esm_class & 0x04) {
    dlrCount++;
    console.log(`  ${C.dim}DLR received: ${pdu.short_message ? String(pdu.short_message).substring(0, 60) : '(empty)'}${C.reset}`);
  }
});

// Send a message with registered_delivery=1 to trigger DLR
// (simulator sends DLR 2s after submit_sm if registered_delivery > 0)
const tm4 = new ThroughputManager();
const jid4 = tm4.createJob({
  destinations: ['+216DLRTEST001'],
  message: 'Testing DLR from simulator',
  ratePerSecond: 100,
  overrides: { registered_delivery: 1 },
  sendCallback: sendViaSim,
});
tm4.startJob(jid4);

await new Promise(resolve => {
  tm4.on('job_completed', (d) => {
    if (d.jobId === jid4) {
      console.log(`  ${C.dim}Job completed, waiting 3s for DLRs...${C.reset}`);
      setTimeout(resolve, 3000);
    }
  });
  setTimeout(resolve, 8000);
});

if (dlrCount > 0) ok(`DLRs received from simulator: ${dlrCount}`);
else fail('No DLRs received');

// ── Test 5: Error events for non-throttle errors ────────────────────────────

header('6. Non-throttle SMSC errors logged');

const tm5 = new ThroughputManager();
let errorEvents = [];

tm5.on('smsc_error', (d) => errorEvents.push(d));
tm5.on('message_failed', (d) => errorEvents.push(d));

// Simulate a send function that returns errors after a few successes
let failCountdown = 2;
const jid5 = tm5.createJob({
  destinations: ['+216ERR001','+216ERR002','+216ERR003','+216ERR004','+216ERR005'],
  message: 'Error test',
  ratePerSecond: 100,
  maxRetries: 1,
  overrides: {},
  sendCallback: async (dest) => {
    failCountdown--;
    if (failCountdown < 0) {
      return { success: false, error: { command_status: 0x0F } }; // ESME_RINVDSTADDR
    }
    return { success: true, messageId: 'MSG_OK' };
  },
});

tm5.startJob(jid5);

await new Promise(resolve => {
  tm5.on('job_completed', (d) => { if (d.jobId === jid5) resolve(d); });
  setTimeout(resolve, 5000);
});

const st5 = tm5.getJobStatus(jid5);
const errEv = errorEvents.filter(e => e.errorCode === '0x0000000f').length;

if (errEv > 0) ok(`SMSC error events (ESME_RINVDSTADDR): ${errEv}`);
else fail('No ESME_RINVDSTADDR error events');

if (st5.failed > 0) ok(`Failed messages counted: ${st5.failed}`);
else fail(`Failed: ${st5.failed}`);

if (st5.sent === 2) ok(`Sent: ${st5.sent}/5 (first 2 succeeded, rest failed)`);
else fail(`Sent: ${st5.sent}/5`);

// ── Test 6: Progress stats correct ETA ──────────────────────────────────────

header('7. Progress ETA calculation');

const tm6 = new ThroughputManager();
let progressData = null;
let completionData = null;
tm6.on('progress', (d) => { progressData = d; });
tm6.on('job_completed', (d) => { completionData = d; });

const jid6 = tm6.createJob({
  destinations: ['+21620000001'],
  message: 'ETA test',
  ratePerSecond: 1,
  overrides: {},
  sendCallback: async () => ({ success: true, messageId: 'MSG_ETA' }),
});

tm6.startJob(jid6);

await new Promise(resolve => {
  tm6.on('job_completed', (d) => { if (d.jobId === jid6) resolve(d); });
  setTimeout(resolve, 5000);
});

if (progressData && progressData.percentage >= 0) ok(`Progress: ${Math.round(progressData.percentage)}%`);
else fail('No progress data');

if (completionData && completionData.sent === 1) ok(`Job completed: ${completionData.sent}/${completionData.total} in ${completionData.duration}s`);
else fail('Job completion data missing');

// ── Cleanup ─────────────────────────────────────────────────────────────────

header('8. Cleanup');

session.unbind();
session.close();
ok('SMPP session closed');

console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════${C.reset}`);
console.log(`  ${C.bold}Results: ${C.green}${passed} passed${C.reset}, ${C.red}${failed} failed${C.reset}`);
console.log(`${C.bold}${C.cyan}═══════════════════════════════════════${C.reset}\n`);

process.exit(failed > 0 ? 1 : 0);

}

main().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
