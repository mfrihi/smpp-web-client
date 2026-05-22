/**
 * SMPP Client - Frontend Application
 * Socket.IO client managing all UI interactions
 */

// =============================================================================
// Socket Connection
// =============================================================================
const socket = io();

socket.on('connect', () => addLogEntry('info', 'WebSocket connected'));
socket.on('disconnect', () => addLogEntry('warning', 'WebSocket disconnected'));

// =============================================================================
// Application State
// =============================================================================
const state = {
  smscStatus: 'disconnected',
  defaults: {},
  overrideExpanded: false,
  overrideValues: {},
  incomingMessages: [],
  deliveryReports: [],
  logs: [],
  stats: {
    messagesSent: 0,
    messagesDelivered: 0,
    messagesFailed: 0,
    messagesReceived: 0
  },
  batchState: null,
  splitPreview: null
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Add a log entry to the state and re-render logs.
 * Trims to max 1000 entries.
 */
function addLogEntry(type, msg, pdu) {
  const entry = {
    type: type,
    msg: msg,
    pdu: pdu || null,
    time: new Date().toISOString()
  };
  state.logs.push(entry);
  if (state.logs.length > 1000) {
    state.logs = state.logs.slice(-1000);
  }
  renderLogs();
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Truncate a string to the given length with ellipsis.
 */
function truncate(str, len) {
  if (typeof str !== 'string') return '';
  if (str.length <= len) return str;
  return str.substring(0, len) + '...';
}

/**
 * Format a timestamp to HH:MM:SS or parse an ISO string.
 */
function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return h + ':' + m + ':' + s;
  } catch (e) {
    return ts;
  }
}

/**
 * Detect if text contains right-to-left (Arabic) Unicode characters.
 */
function detectRtl(text) {
  if (typeof text !== 'string') return false;
  // Arabic Unicode range: U+0600 - U+06FF, U+0750 - U+077F, U+08A0 - U+08FF
  const rtlRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
  return rtlRegex.test(text);
}

/**
 * Copy current default values to the override section fields.
 */
function populateOverrideWithDefaults() {
  // No override fields to populate — split config uses its own defaults
}

// =============================================================================
// Render Functions
// =============================================================================

/**
 * Render the log entries into the log container.
 * Newest entries appear at the top (auto-scrolls to top on each render).
 */
function renderLogs() {
  const container = document.getElementById('log-entries');
  if (!container) return;
  let html = '';
  for (let i = state.logs.length - 1; i >= 0; i--) {
    const entry = state.logs[i];
    const time = formatTime(entry.time);
    let rowClass = 'log-entry';
    // Color-code by type
    switch (entry.type) {
      case 'info':
        rowClass += ' log-info';
        break;
      case 'warning':
        rowClass += ' log-warning';
        break;
      case 'error':
        rowClass += ' log-error';
        break;
      case 'success':
        rowClass += ' log-success';
        break;
      case 'debug':
        rowClass += ' log-debug';
        break;
      case 'pdu':
        rowClass += ' log-pdu';
        break;
      default:
        break;
    }
    html += '<div class="' + rowClass + '">';
    html += '<span class="log-time">[' + escapeHtml(time) + ']</span> ';
    html += '<span class="log-type">' + escapeHtml(entry.type.toUpperCase()) + ':</span> ';
    html += '<span class="log-msg">' + escapeHtml(entry.msg) + '</span>';
    if (entry.pdu) {
      html += ' <span class="log-pdu-data">' + escapeHtml(entry.pdu) + '</span>';
    }
    html += '</div>';
  }
  container.innerHTML = html;
  container.scrollTop = 0;
}

/**
 * Render incoming messages into the inbox table.
 */
function renderIncomingMessages() {
  const tbody = document.getElementById('inbox-entries-tbody');
  if (!tbody) return;
  let html = '';
  for (const msg of state.incomingMessages) {
    const time = formatTime(msg.received_at || msg.time);
    const msgText = msg.message || msg.short_message || msg.text || '';
    const isRtl = detectRtl(msgText);
    const dir = isRtl ? ' dir="rtl"' : '';
    const displayText = truncate(msgText, 160);
    html += '<tr>';
    html += '<td>' + escapeHtml(time) + '</td>';
    html += '<td>' + escapeHtml(msg.source_addr || msg.source || '') + '</td>';
    html += '<td>' + escapeHtml(msg.destination_addr || msg.destination || '') + '</td>';
    html += '<td' + dir + '>' + escapeHtml(displayText) + '</td>';
    html += '<td>' + (msg.esm_class !== undefined ? '0x' + msg.esm_class.toString(16).padStart(2, '0') : 'SMS') + '</td>';
    html += '</tr>';
  }
  tbody.innerHTML = html;
}

/**
 * Render delivery reports into the DLR table with color-coded status badges.
 */
function renderDeliveryReports() {
  const tbody = document.getElementById('dlr-entries-tbody');
  if (!tbody) return;
  let html = '';
  for (const dlr of state.deliveryReports) {
    const time = formatTime(dlr.received_at || dlr.time);
    const status = (dlr.status || dlr.stat || '').toLowerCase();
    let badgeClass = 'badge badge-';
    const badgeText = escapeHtml(dlr.status || dlr.stat || 'UNKNOWN');
    // Color-code status badges per SMPP standard
    if (status === 'delivrd' || status === 'delivered') {
      badgeClass += 'success';
    } else if (status === 'undeliv' || status === 'undelivered' || status === 'rejectd' || status === 'rejected') {
      badgeClass += 'danger';
    } else if (status === 'expired' || status === 'deleted') {
      badgeClass += 'warning';
    } else if (status === 'acceptd' || status === 'accepted' || status === 'enroute') {
      badgeClass += 'info';
    } else {
      badgeClass += 'secondary';
    }
    html += '<tr>';
    html += '<td>' + escapeHtml(time) + '</td>';
    html += '<td>' + escapeHtml(dlr.message_id || '') + '</td>';
    html += '<td>' + escapeHtml(dlr.source_addr || '') + '</td>';
    html += '<td>' + escapeHtml(dlr.destination_addr || '') + '</td>';
    html += '<td><span class="' + badgeClass + '">' + badgeText + '</span></td>';
    html += '<td>' + escapeHtml(String(dlr.submitted_count !== undefined ? dlr.submitted_count : '0')) + '</td>';
    html += '<td>' + escapeHtml(String(dlr.delivered_count !== undefined ? dlr.delivered_count : '0')) + '</td>';
    html += '</tr>';
  }
  tbody.innerHTML = html;
}

/**
 * Render batch progress bar and status text.
 */
function renderBatchProgress() {
  const progressContainer = document.getElementById('batch-progress');
  const progressBar = document.getElementById('batch-progress-bar');
  const progressText = document.getElementById('batch-progress-text');
  const progressStatus = document.getElementById('batch-status');
  if (!progressContainer || !progressBar || !progressText) return;
  if (state.batchState) {
    progressContainer.style.display = 'block';
    const total = state.batchState.total || 1;
    const sent = state.batchState.sent || 0;
    const percent = Math.round((sent / total) * 100);
    progressBar.style.width = percent + '%';
    progressBar.setAttribute('aria-valuenow', percent);
    progressText.textContent = sent + ' / ' + total + ' (' + percent + '%)';
    if (progressStatus) {
      progressStatus.textContent = state.batchState.status || 'Sending...';
    }
    if (state.batchState.complete) {
      progressBar.className = 'progress-bar bg-success';
    } else if (state.batchState.error) {
      progressBar.className = 'progress-bar bg-danger';
    } else {
      progressBar.className = 'progress-bar bg-primary progress-bar-striped progress-bar-animated';
    }
  } else {
    progressContainer.style.display = 'none';
  }
}

// =============================================================================
// Throughput Sender - Frontend Logic
// =============================================================================

(function() {
  'use strict';

  var toggleBtn    = document.getElementById('throughput-toggle-btn');
  var section      = document.getElementById('throughput-section');
  var startBtn     = document.getElementById('throughput-start');
  var pauseBtn     = document.getElementById('throughput-pause');
  var stopBtn      = document.getElementById('throughput-stop');
  var rateInput    = document.getElementById('throughput-rate');
  var totalInput   = document.getElementById('throughput-total');
  var maxRetriesIn = document.getElementById('throughput-max-retries');
  var progressArea = document.getElementById('throughput-progress-area');
  var fillBar      = document.getElementById('throughput-progress-fill');
  var pctSpan      = document.getElementById('throughput-percentage');
  var sentSpan     = document.getElementById('throughput-sent');
  var failedSpan   = document.getElementById('throughput-failed');
  var retriesSpan  = document.getElementById('throughput-retries');
  var currRateSpan = document.getElementById('throughput-current-rate');
  var tgtRateSpan  = document.getElementById('throughput-target-rate-display');
  var etaSpan      = document.getElementById('throughput-eta');
  var statusText   = document.getElementById('throughput-status-text');
  var throttleWarn = document.getElementById('throughput-throttle-warning');
  var errorSummary = document.getElementById('throughput-error-summary');
  var errorList    = document.getElementById('throughput-error-list');
  var activeJobId  = null;
  var lastErrors   = [];

  if (toggleBtn) {
    toggleBtn.addEventListener('click', function() {
      var open = section.style.display === 'block';
      section.style.display = open ? 'none' : 'block';
      toggleBtn.classList.toggle('open', !open);
    });
  }

  function getDest() {
    var mode = document.getElementById('send-destination-mode');
    var mv = mode ? mode.value : 'single';
    if (mv === 'single') {
      var el = document.getElementById('send-destination');
      return el && el.value.trim() ? [el.value.trim()] : [];
    }
    var el = document.getElementById('send-destinations');
    return el && el.value.trim() ? el.value.split('\n').map(function(d){ return d.trim(); }).filter(Boolean) : [];
  }

  function getMsg() {
    var el = document.getElementById('send-message');
    return el ? el.value : '';
  }

  function getOverrides() {
    function v(id) { var e=document.getElementById(id); return e ? e.value : ''; }
    var o = {};
    var sa = v('def-source-addr'); if (sa) o.source_addr = sa;
    o.source_addr_ton = parseInt(v('def-source-ton')) || 1;
    o.source_addr_npi = parseInt(v('def-source-npi')) || 1;
    o.dest_addr_ton   = parseInt(v('def-dest-ton')) || 1;
    o.dest_addr_npi   = parseInt(v('def-dest-npi')) || 1;
    o.data_coding     = parseInt(v('def-data-coding')) || 0;
    o.priority_flag   = parseInt(v('def-priority')) || 0;
    var reg = document.getElementById('def-registered-delivery');
    o.registered_delivery = reg && reg.checked ? 1 : 0;
    o.message_class   = parseInt(v('def-message-class')) || 1;
    var svc = v('def-service-type'); if (svc) o.service_type = svc;
    var sch = v('def-schedule'); if (sch) o.schedule_delivery_time = sch;
    var vld = v('def-validity'); if (vld) o.validity_period = vld;
    var esm = v('def-esm-class'); if (esm) o.esm_class = parseInt(esm);
    var pid = v('def-protocol-id'); if (pid) o.protocol_id = parseInt(pid);
    var rpf = document.getElementById('def-replace-if-present');
    o.replace_if_present_flag = rpf && rpf.checked ? 1 : 0;
    var sm = v('override-split-mode'); if (sm) o.split_mode = sm;
    o.max_segments = parseInt(v('override-max-segments')) || 10;
    o.split_udh_format = v('override-udh-format') || '8bit';
    return o;
  }

  // ── Log to Event Log only (info events) ──────────────────────────────────
  function logThroughputEvent(type, msg) {
    var logMsg = '[THROUGHPUT] ' + type + ': ' + msg;
    if (window.addLogEntry) window.addLogEntry(logMsg, 'info');
  }

  // ── Log to Event Log + error summary (actual SMSC errors) ────────────────
  function addThroughputError(type, code, msg, dest) {
    var ts = new Date().toLocaleTimeString();
    lastErrors.unshift({ ts: ts, type: type, code: code, msg: msg, dest: dest });
    if (lastErrors.length > 10) lastErrors.pop();
    if (errorSummary && errorList) {
      if (lastErrors.length === 0) { errorSummary.style.display = 'none'; }
      else {
        errorSummary.style.display = 'block';
        errorList.innerHTML = lastErrors.slice(0,5).map(function(e) {
          return '<div>[' + e.ts + '] ' + e.type + ': ' + e.msg + (e.dest ? ' (' + e.dest + ')' : '') + '</div>';
        }).join('');
      }
    }
    var logMsg = '[THROUGHPUT] ' + type + (code ? ' (' + code + ')' : '') + ': ' + msg;
    if (window.addLogEntry) window.addLogEntry(logMsg, 'error');
  }

  function updProg(d) {
    if (!d) return;
    var p = d.percentage || 0;
    if (fillBar)     fillBar.style.width = p + '%';
    if (pctSpan)     pctSpan.textContent = Math.round(p) + '%';
    if (sentSpan)    sentSpan.textContent = d.sent || 0;
    if (failedSpan)  failedSpan.textContent = d.failed || 0;
    if (retriesSpan) retriesSpan.textContent = d.retryCount || 0;
    if (currRateSpan) currRateSpan.textContent = d.currentRate || 0;
    if (etaSpan)     etaSpan.textContent = d.eta || '--:--';
    if (statusText) {
      if (d.status === 'paused')    statusText.textContent = '⏸ Paused';
      else if (d.status === 'completed') statusText.textContent = '✅ Completed';
      else if (d.status === 'stopped')   statusText.textContent = '⏹ Stopped';
      else if (d.status === 'running')   statusText.textContent = '▶ Running';
    }
  }

  function resetUI() {
    if (fillBar)     fillBar.style.width = '0%';
    if (pctSpan)     pctSpan.textContent = '0%';
    if (sentSpan)    sentSpan.textContent = '0';
    if (failedSpan)  failedSpan.textContent = '0';
    if (retriesSpan) retriesSpan.textContent = '0';
    if (currRateSpan) currRateSpan.textContent = '0';
    if (etaSpan)     etaSpan.textContent = '--:--';
    if (statusText)  statusText.textContent = 'Idle';
    if (progressArea) progressArea.style.display = 'none';
    if (errorSummary) errorSummary.style.display = 'none';
    if (throttleWarn) throttleWarn.style.display = 'none';
    lastErrors = [];
  }

  if (startBtn) {
    startBtn.addEventListener('click', function() {
      // If there's an active paused job, resume it instead of creating new
      if (activeJobId && typeof socket !== 'undefined') {
        socket.emit('throughput:resume', { jobId: activeJobId });
        if (statusText) statusText.textContent = 'Resuming...';
        startBtn.disabled = true;
        pauseBtn.disabled = false;
        return;
      }

      var dests = getDest();
      var msg   = getMsg();
      var rate  = parseInt(rateInput ? rateInput.value : 10);
      var total = parseInt(totalInput ? totalInput.value : 100);
      var retry = parseInt(maxRetriesIn ? maxRetriesIn.value : 3);

      if (!dests.length) { addThroughputError('Validation', null, 'No destination(s)'); return; }
      if (!msg.trim())   { addThroughputError('Validation', null, 'Message empty'); return; }
      if (rate < 1 || rate > 100) { addThroughputError('Validation', null, 'Rate must be 1-100'); return; }
      if (total < 1 || total > 100000) { addThroughputError('Validation', null, 'Total must be 1-100000'); return; }

      if (progressArea) progressArea.style.display = 'block';
      if (tgtRateSpan)  tgtRateSpan.textContent = String(rate);
      startBtn.disabled = true;
      pauseBtn.disabled = false;
      stopBtn.disabled  = false;
      if (statusText) statusText.textContent = 'Starting...';

      if (typeof socket !== 'undefined') {
        socket.emit('throughput:start', {
          destinations: dests,
          message: msg,
          ratePerSecond: rate,
          totalCount: total,
          maxRetries: retry,
          overrides: getOverrides(),
        });
      }
    });
  }

  if (pauseBtn) {
    pauseBtn.addEventListener('click', function() {
      if (typeof socket !== 'undefined') {
        socket.emit('throughput:pause', { jobId: activeJobId });
        if (statusText) statusText.textContent = '⏸ Pausing...';
        startBtn.disabled = false;     // Enable START for resume
        pauseBtn.disabled = true;      // Disable PAUSE
      }
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', function() {
      if (typeof socket !== 'undefined') {
        socket.emit('throughput:stop', { jobId: activeJobId });
        if (statusText) statusText.textContent = '⏹ Stopping...';
      }
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled  = true;
      activeJobId = null;
    });
  }

  if (typeof socket !== 'undefined') {
    socket.on('throughput:started', function(d) {
      activeJobId = d.jobId;
      if (statusText) statusText.textContent = '▶ Running';
      logThroughputEvent('Job Started', 'Job ' + d.jobId + ' — Rate: ' + d.rate + ' msg/s, Total: ' + d.totalCount);
    });
    socket.on('throughput:progress', function(d) { updProg(d); });
    socket.on('throughput:error', function(d) {
      addThroughputError(d.errorName || d.errorType || 'SMSC Error', d.errorCode, d.errorMessage || d.message, d.destination);
    });
    socket.on('throughput:paused', function(d) {
      if (statusText) statusText.textContent = '⏸ Paused';
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      if (d.reason === 'throttle') addThroughputError('Auto-Paused', null, 'Job paused due to SMSC throttling');
    });
    socket.on('throughput:resumed', function(d) {
      if (statusText) statusText.textContent = '▶ Running';
      startBtn.disabled = true;
      pauseBtn.disabled = false;
      logThroughputEvent('Job Resumed', 'Rate: ' + d.rate + ' msg/s');
    });
    socket.on('throughput:completed', function(d) {
      if (statusText) statusText.textContent = '✅ Completed';
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled  = true;
      activeJobId = null;
      logThroughputEvent('Job Completed', 'Sent: ' + d.sent + ', Failed: ' + d.failed + ', Duration: ' + d.duration + 's');
    });
    socket.on('throughput:rate_updated', function(d) {
      if (rateInput)  rateInput.value = String(d.newRate);
      if (tgtRateSpan) tgtRateSpan.textContent = String(d.newRate);
      if (currRateSpan) currRateSpan.textContent = String(d.newRate);
      if (throttleWarn) {
        throttleWarn.style.display = 'inline-block';
        setTimeout(function() { throttleWarn.style.display = 'none'; }, 5000);
      }
    });
    socket.on('throughput:stopped', function(d) {
      if (statusText) statusText.textContent = '⏹ Stopped';
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled  = true;
      activeJobId = null;
    });
    socket.on('throughput:retry', function(d) {
      addThroughputError('Retry', null, 'Retrying ' + d.destination + ' (' + d.retryCount + '/' + d.maxRetries + ')');
    });
    socket.on('throughput:cleanup', function() {
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled  = true;
      activeJobId = null;
    });
  }
})();

// =============================================================================
// Socket Event Handlers
// =============================================================================

socket.on('smsc:status', function (data) {
  const indicator = document.getElementById('status-indicator');
  const text = document.getElementById('status-text');
  const connectBtn = document.getElementById('btn-connect');
  const disconnectBtn = document.getElementById('btn-disconnect');
  const status = data && (data.state || data.status) ? (data.state || data.status) : 'disconnected';
  state.smscStatus = status;
  // Update indicator class
  if (indicator) {
    indicator.className = 'status-dot';
    if (status === 'connected' || status === 'bound') {
      indicator.classList.add('connected');
    } else if (status === 'connecting' || status === 'binding') {
      indicator.classList.add('connecting');
    } else {
      indicator.classList.add('disconnected');
    }
  }
  // Update status text
  if (text) {
    text.textContent = (status.charAt(0).toUpperCase() + status.slice(1));
  }
  // Enable/disable buttons
  if (connectBtn) {
    connectBtn.disabled = (status === 'connected' || status === 'bound' || status === 'connecting' || status === 'binding');
  }
  if (disconnectBtn) {
    disconnectBtn.disabled = (status === 'disconnected' || status === 'unbound');
  }
  addLogEntry('info', 'SMSC status changed to: ' + status);
});

// Listen for explicit connection errors
socket.on('smsc:error', function (data) {
  const msg = data && data.message ? data.message : 'Unknown connection error';
  addLogEntry('error', msg);
  const indicator = document.getElementById('status-indicator');
  const text = document.getElementById('status-text');
  if (indicator) {
    indicator.className = 'status-dot';
    indicator.classList.add('disconnected');
  }
  if (text) text.textContent = 'Error';
  state.smscStatus = 'disconnected';
});

socket.on('config:defaults', function (data) {
  if (!data) return;
  state.defaults = data;
  // Populate all default field values
  const fieldMappings = {
    'def-source-addr': 'source_addr',
    'def-source-ton': 'source_addr_ton',
    'def-source-npi': 'source_addr_npi',
    'def-dest-ton': 'dest_addr_ton',
    'def-dest-npi': 'dest_addr_npi',
    'def-service-type': 'service_type',
    'def-priority': 'priority_flag',
    'def-registered-delivery': 'registered_delivery',
    'def-data-coding': 'data_coding',
    'def-validity': 'validity_period',
    'def-schedule': 'schedule_delivery_time',
    'def-esm-class': 'esm_class',
    'def-protocol-id': 'protocol_id',
    'def-replace-if-present': 'replace_if_present_flag',
    'def-sm-default-msg': 'sm_default_msg_id',
    'def-message-class': 'message_class'
  };
  for (const [elId, key] of Object.entries(fieldMappings)) {
    const el = document.getElementById(elId);
    if (el && data[key] !== undefined) {
      if (el.type === 'checkbox') {
        el.checked = data[key] === 1 || data[key] === true;
      } else {
        el.value = data[key];
      }
    }
  }
});

// ── Catch message errors from the backend (e.g. not connected, invalid params) ──
socket.on('message:error', function (data) {
  const errMsg = data && data.message ? data.message : 'Unknown send error';
  addLogEntry('error', 'Send failed: ' + errMsg);
  state.stats.messagesFailed++;
  updateStatsDisplay();
});

socket.on('message:sent', function (data) {
  addLogEntry('success', 'Message sent: ' + (data && data.message_id ? data.message_id : 'unknown'));
  state.stats.messagesSent++;
  updateStatsDisplay();
});

socket.on('message:replaced', function (data) {
  addLogEntry('info', 'Message replaced: ' + (data && data.message_id ? data.message_id : 'unknown'));
});

socket.on('message:cancelled', function (data) {
  addLogEntry('warning', 'Message cancelled: ' + (data && data.message_id ? data.message_id : 'unknown'));
});

socket.on('message:incoming', function (data) {
  if (!data) return;
  state.incomingMessages.unshift(data);
  renderIncomingMessages();
  state.stats.messagesReceived++;
  updateStatsDisplay();
  addLogEntry('info', 'Incoming message from: ' + (data.source_addr || data.source || 'unknown'));
});

socket.on('message:dlr', function (data) {
  if (!data) return;
  state.deliveryReports.unshift(data);
  renderDeliveryReports();
  // Update stats based on DLR status
  const status = (data.stat || data.status || '').toLowerCase();
  if (status === 'delivered' || status === 'delivrd') {
    state.stats.messagesDelivered++;
  } else if (status === 'failed' || status === 'undeliv' || status === 'rejected') {
    state.stats.messagesFailed++;
  }
  updateStatsDisplay();
});

socket.on('message:batch_progress', function (data) {
  if (!data) return;
  // Normalise backend field names (completed → sent, phase → complete/status)
  state.batchState = {
    total: data.total || 0,
    sent: data.sent || data.completed || 0,
    status: data.status || (data.phase === 'complete' ? 'Done' : (data.phase === 'start' ? 'Sending...' : 'Sending...')),
    complete: data.complete || data.phase === 'complete',
    error: data.error || null,
    results: data.results || [],
  };
  renderBatchProgress();
  if (state.batchState.complete) {
    addLogEntry('success', 'Batch complete: ' + state.batchState.sent + ' messages sent');
  } else if (state.batchState.error) {
    addLogEntry('error', 'Batch error: ' + state.batchState.error);
  }
});

// ── Real-time character counter — no server call, instant ──────────
document.getElementById('send-message').addEventListener('input', function () {
  const text = this.value;
  const len = text.length;
  const current = document.getElementById('char-current');
  const limitEl = document.getElementById('char-limit');
  const partsEl = document.getElementById('char-parts');
  const encodingInfo = document.getElementById('encoding-info');

  // Detect encoding locally (fast path)
  let dataCoding = 0; // GSM-7
  let maxPerSegment = 160;
  let encodingName = 'GSM 7-bit';
  let ucs2 = false;

  // Check for non-GSM-7 characters
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    if (code > 127 || (code > 0x7e && code < 0xa0)) {
      ucs2 = true;
      break;
    }
  }

  if (ucs2) {
    // Check for emoji (supplementary planes)
    let isEmoji = false;
    for (let i = 0; i < len; i++) {
      const code = text.codePointAt(i);
      if (code > 0xffff) { isEmoji = true; break; }
      if ((code >= 0x0600 && code <= 0x06FF) || (code >= 0x0750 && code <= 0x077F)) { isEmoji = true; break; }
    }
    dataCoding = 8;
    maxPerSegment = 70;
    encodingName = isEmoji ? 'UCS-2 / Emoji' : 'UCS-2';
  } else {
    dataCoding = 0;
    maxPerSegment = 160;
    encodingName = 'GSM 7-bit';
  }

  // Calculate segments
  const segLimit = dataCoding === 8 ? 67 : 153;
  const segments = len === 0 ? 1 : Math.ceil(len / segLimit);

  // Update UI
  if (current) current.textContent = len;
  if (limitEl) limitEl.textContent = maxPerSegment;
  if (partsEl) partsEl.textContent = segments > 1 ? ' (' + segments + ' segments)' : '';

  // Color coding
  const counter = document.getElementById('send-char-count');
  if (counter) {
    counter.classList.remove('warning', 'danger');
    if (len > maxPerSegment * 0.9) counter.classList.add('danger');
    else if (len > maxPerSegment * 0.7) counter.classList.add('warning');
  }

  // Encoding badge
  if (encodingInfo) {
    encodingInfo.textContent = encodingName;
    encodingInfo.className = 'encoding-info active';
    if (dataCoding === 8) {
      encodingInfo.style.borderColor = 'rgba(255,187,0,0.3)';
      encodingInfo.style.color = '#ffbb00';
      encodingInfo.style.background = 'rgba(255,187,0,0.08)';
    } else {
      encodingInfo.style.borderColor = 'rgba(0,255,255,0.3)';
      encodingInfo.style.color = '#00ffff';
      encodingInfo.style.background = 'rgba(0,255,255,0.08)';
    }
  }

  // Also emit to server for proper SMPP encoding
  socket.emit('encoding:detect', { message: text });

  // Trigger split preview
  triggerSplitPreview();
});

socket.on('smpp:event', function (data) {
  if (!data) return;
  addLogEntry(data.type || 'info', data.message || data.msg || 'SMPP event');
});

// ── Split Preview ─────────────────────────────────────────────
socket.on('message:split_preview', function (data) {
  updateSplitPreview(data);
});

// ── Encoding detection response from server ──────────────────────
socket.on('encoding:detected', function (data) {
  if (!data) return;
  // Update UI with server's SMPP-accurate encoding info
  var encInfo = document.getElementById('encoding-info');
  if (encInfo) {
    encInfo.textContent = data.encoding + (data.reason ? ' (' + data.reason + ')' : '');
    encInfo.className = 'encoding-info active';
    var borderColor = data.data_coding === 8 ? 'rgba(255,187,0,0.3)' : 'rgba(0,255,255,0.3)';
    var textColor = data.data_coding === 8 ? '#ffbb00' : '#00ffff';
    encInfo.style.borderColor = borderColor;
    encInfo.style.color = textColor;
    encInfo.style.background = data.data_coding === 8 ? 'rgba(255,187,0,0.08)' : 'rgba(0,255,255,0.08)';
  }
});

// ── Incoming message list (historical) ───────────────────────────
socket.on('message:incoming_list', function (data) {
  if (data && Array.isArray(data.messages)) {
    state.incomingMessages = data.messages;
    renderIncomingMessages();
  }
});

// ── DLR list (historical) ────────────────────────────────────────
socket.on('message:dlr_list', function (data) {
  if (data && Array.isArray(data.reports)) {
    state.deliveryReports = data.reports;
    renderDeliveryReports();
  }
});

// =============================================================================
// Update Functions
// =============================================================================

function updateSplitPreview(splitInfo) {
  const previewDiv = document.getElementById('split-preview');
  const manualContainer = document.getElementById('manual-segments-container');
  if (!previewDiv) return;

  if (!splitInfo || splitInfo.error) {
    previewDiv.className = 'split-preview error';
    previewDiv.style.display = 'block';
    previewDiv.innerHTML = '<span>✗ ' + escapeHtml(splitInfo ? splitInfo.error : 'No preview') + '</span>';
    return;
  }

  previewDiv.style.display = 'block';

  if (splitInfo.segments <= 1) {
    previewDiv.className = 'split-preview info';
    previewDiv.innerHTML = '<span>✓ Fits in 1 segment (' + splitInfo.totalChars + '/' + splitInfo.maxPerSegment + ' chars)</span>';
  } else {
    previewDiv.className = 'split-preview warning';
    var details = '';
    if (splitInfo.segmentDetails) {
      var badges = '';
      for (var i = 0; i < splitInfo.segmentDetails.length; i++) {
        badges += '<span class="segment-badge">Seg ' + splitInfo.segmentDetails[i].num + ': ' + splitInfo.segmentDetails[i].length + ' chars</span>';
      }
      details = '<div class="segment-details">' + badges + '</div>';
    }
    previewDiv.innerHTML = '<span>⚠ Splits into ' + splitInfo.segments + ' segments (' + splitInfo.totalChars + ' chars)</span>' + details;
  }

  // Show/hide manual segments container
  var splitMode = document.getElementById('override-split-mode');
  if (manualContainer && splitMode) {
    manualContainer.style.display = splitMode.value === 'manual' ? 'block' : 'none';
  }
}

function triggerSplitPreview() {
  var message = document.getElementById('send-message');
  if (!message || !message.value) {
    var previewDiv = document.getElementById('split-preview');
    if (previewDiv) previewDiv.style.display = 'none';
    return;
  }
  var dataCoding = document.getElementById('def-data-coding');
  var maxSegments = document.getElementById('override-max-segments');
  var splitMode = document.getElementById('override-split-mode');
  var udhFormat = document.getElementById('override-udh-format');
  socket.emit('message:split_preview', {
    message: message.value,
    data_coding: dataCoding ? parseInt(dataCoding.value) : 0,
    max_segments: maxSegments ? parseInt(maxSegments.value) || 10 : 10,
    split_mode: splitMode ? splitMode.value : 'auto',
    udh_format: udhFormat ? udhFormat.value : '8bit'
  });
}

// =============================================================================
// Stats Display Update
// =============================================================================

function updateStatsDisplay() {
  const sentEl = document.getElementById('stat-sent');
  const deliveredEl = document.getElementById('stat-delivered');
  const failedEl = document.getElementById('stat-failed');
  const receivedEl = document.getElementById('stat-received');
  if (sentEl) sentEl.textContent = state.stats.messagesSent;
  if (deliveredEl) deliveredEl.textContent = state.stats.messagesDelivered;
  if (failedEl) failedEl.textContent = state.stats.messagesFailed;
  if (receivedEl) receivedEl.textContent = state.stats.messagesReceived;
}

// =============================================================================
// Gather Form Values Helper
// =============================================================================

function gatherFormValues() {
  const data = {};
  const el = document.getElementById('smsc-host');
  if (el) data.host = el.value;
  const el2 = document.getElementById('smsc-port');
  if (el2) data.port = parseInt(el2.value) || 2775;
  const el3 = document.getElementById('smsc-system-id');
  if (el3) data.system_id = el3.value;
  const el4 = document.getElementById('smsc-password');
  if (el4) data.password = el4.value;
  const el5 = document.getElementById('smsc-system-type');
  if (el5) data.system_type = el5.value;
  const el6 = document.getElementById('smsc-bind-mode');
  if (el6) data.bind_mode = el6.value;
  return data;
}

function gatherDefaultsValues() {
  const fieldMappings = {
    'def-source-addr': 'source_addr',
    'def-source-ton': 'source_addr_ton',
    'def-source-npi': 'source_addr_npi',
    'def-dest-ton': 'dest_addr_ton',
    'def-dest-npi': 'dest_addr_npi',
    'def-service-type': 'service_type',
    'def-priority': 'priority_flag',
    'def-registered-delivery': 'registered_delivery',
    'def-data-coding': 'data_coding',
    'def-validity': 'validity_period',
    'def-schedule': 'schedule_delivery_time',
    'def-esm-class': 'esm_class',
    'def-protocol-id': 'protocol_id',
    'def-replace-if-present': 'replace_if_present_flag',
    'def-sm-default-msg': 'sm_default_msg_id',
    'def-message-class': 'message_class'
  };
  const data = {};
  for (const [elId, key] of Object.entries(fieldMappings)) {
    const el = document.getElementById(elId);
    if (el) {
      if (el.type === 'checkbox') {
        data[key] = el.checked ? 1 : 0;
      } else {
        data[key] = el.value;
      }
    }
  }
  return data;
}

function gatherOverrideValues() {
  const fieldMappings = {
    'split-mode': 'split_mode',
    'max-segments': 'max_segments',
    'udh-format': 'udh_format'
  };
  const data = {};
  for (const [elSuffix, key] of Object.entries(fieldMappings)) {
    const el = document.getElementById('override-' + elSuffix);
    if (el && el.value.trim() !== '') {
      data[key] = el.value;
    }
  }
  return data;
}

// =============================================================================
// UI Event Handlers
// =============================================================================

// --- Connect Button ---
document.getElementById('btn-connect').onclick = function () {
  const data = gatherFormValues();
  socket.emit('smsc:connect', data);
};

// --- Disconnect Button ---
document.getElementById('btn-disconnect').onclick = function () {
  socket.emit('smsc:disconnect');
};

// --- Defaults Inputs ---
// Watch all default input fields for changes
const defaultInputIds = [
  'def-source-addr', 'def-source-ton', 'def-source-npi',
  'def-dest-ton', 'def-dest-npi', 'def-service-type',
  'def-priority', 'def-registered-delivery', 'def-data-coding',
  'def-validity', 'def-schedule', 'def-esm-class',
  'def-protocol-id', 'def-replace-if-present', 'def-sm-default-msg',
  'def-message-class'
];
for (const id of defaultInputIds) {
  const el = document.getElementById(id);
  if (el) {
    el.onchange = function () {
      const data = gatherDefaultsValues();
      socket.emit('config:update_defaults', data);
    };
  }
}

// --- Send Button ---
document.getElementById('btn-send').onclick = function () {
  const destMode = document.getElementById('send-destination-mode');
  const destinationsInput = document.getElementById('send-destinations');
  const messageInput = document.getElementById('send-message');
  const mode = destMode ? destMode.value : 'single';
  const message = messageInput ? messageInput.value : '';
  let destinations;
  if (mode === 'batch' || mode === 'multiple') {
    const raw = destinationsInput ? destinationsInput.value : '';
    destinations = raw.split('\n').map(function (d) { return d.trim(); }).filter(function (d) { return d.length > 0; });
    if (destinations.length === 0) {
      addLogEntry('error', 'Please enter at least one destination address');
      return;
    }
    if (!message) {
      addLogEntry('error', 'Please enter a message');
      return;
    }
    addLogEntry('info', 'Sending to ' + destinations.length + ' destinations...');
    const overrides = gatherOverrideValues();
    socket.emit('message:send_batch', {
      destinations: destinations,
      short_message: message,
      overrides: overrides
    });
  } else {
    const singleDest = document.getElementById('send-destination');
    const dest = singleDest ? singleDest.value : '';
    if (!dest) {
      addLogEntry('error', 'Please enter a destination address');
      return;
    }
    if (!message) {
      addLogEntry('error', 'Please enter a message');
      return;
    }
    addLogEntry('info', 'Sending message to ' + dest + '...');
    const overrides = gatherOverrideValues();
    socket.emit('message:send', {
      destination_addr: dest,
      short_message: message,
      overrides: overrides
    });
  }
};

// --- Replace Button ---
document.getElementById('btn-replace').onclick = function () {
  const msgIdEl = document.getElementById('replace-message-id');
  const srcEl = document.getElementById('replace-source-addr');
  const destEl = document.getElementById('replace-destination-addr');
  const msgEl = document.getElementById('replace-message');
  const data = {};
  if (msgIdEl) data.message_id = msgIdEl.value;
  if (srcEl) data.source_addr = srcEl.value;
  if (destEl) data.destination_addr = destEl.value;
  if (msgEl) data.short_message = msgEl.value;
  if (!data.message_id) {
    addLogEntry('error', 'Please enter a message ID to replace');
    return;
  }
  socket.emit('message:replace', data);
};

// --- Cancel Button ---
document.getElementById('btn-cancel').onclick = function () {
  const cancelBy = document.getElementById('cancel-by');
  const by = cancelBy ? cancelBy.value : 'message_id';
  const data = {
    cancel_by: by
  };
  if (by === 'message_id') {
    const msgIdEl = document.getElementById('cancel-message-id');
    data.message_id = msgIdEl ? msgIdEl.value : '';
    if (!data.message_id) {
      addLogEntry('error', 'Please enter a message ID to cancel');
      return;
    }
  } else if (by === 'source_dest') {
    const srcEl = document.getElementById('cancel-source-addr');
    const destEl = document.getElementById('cancel-destination-addr');
    data.source_addr = srcEl ? srcEl.value : '';
    data.destination_addr = destEl ? destEl.value : '';
    if (!data.source_addr || !data.destination_addr) {
      addLogEntry('error', 'Please enter both source and destination addresses');
      return;
    }
  }
  socket.emit('message:cancel', data);
};

// --- Cancel-by Switch (single handler: addEventListener preferred for mobile) ---
document.getElementById('cancel-by').onchange = null;

// --- Other UI handlers wrapped in DOMContentLoaded for safety ---
document.addEventListener('DOMContentLoaded', function() {
  // Override Toggle
  var ot = document.getElementById('override-toggle');
  if (ot) ot.addEventListener('click', function() {
    state.overrideExpanded = !state.overrideExpanded;
    var section = document.getElementById('override-section');
    if (section) section.style.display = state.overrideExpanded ? 'block' : 'none';
    this.textContent = state.overrideExpanded ? 'Hide Overrides ▲' : 'Show Overrides ▼';
    if (state.overrideExpanded) populateOverrideWithDefaults();
  });
  
  // Destination Mode
  var dm = document.getElementById('send-destination-mode');
  if (dm) dm.addEventListener('change', function() {
    var mode = this.value;
    var single = document.getElementById('destination-single-group');
    var multi = document.getElementById('dest-multiple-group');
    if (mode === 'batch' || mode === 'multiple') {
      if (single) single.classList.add('hidden');
      if (multi) multi.classList.remove('hidden');
    } else {
      if (single) single.classList.remove('hidden');
      if (multi) multi.classList.add('hidden');
    }
  });
  
  // Cancel-by Switch
  var cb = document.getElementById('cancel-by');
  if (cb) cb.addEventListener('change', function() {
    var by = this.value;
    var msgGroup = document.getElementById('cancel-message-id-group');
    var srcGroup = document.getElementById('cancel-source-dest-group');
    if (by === 'message_id') {
      if (msgGroup) msgGroup.classList.remove('hidden');
      if (srcGroup) srcGroup.classList.add('hidden');
    } else if (by === 'source_dest') {
      if (msgGroup) msgGroup.classList.add('hidden');
    if (srcGroup) srcGroup.classList.remove('hidden');
    }
  });

  // --- Enable/disable fields based on split mode ---
  function updateSplitModeFields() {
    var sm = document.getElementById('override-split-mode');
    var maxSeg = document.getElementById('override-max-segments');
    var udhFmt = document.getElementById('override-udh-format');
    if (!sm) return;
    var val = sm.value;
    var showMaxSeg = (val === 'auto' || val === 'sar');
    var showUdhFmt = (val === 'auto');
    if (maxSeg) {
      maxSeg.disabled = !showMaxSeg;
      maxSeg.parentElement.classList.toggle('field-disabled', !showMaxSeg);
    }
    if (udhFmt) {
      udhFmt.disabled = !showUdhFmt;
      udhFmt.parentElement.classList.toggle('field-disabled', !showUdhFmt);
    }
  }

  // --- Split Mode Change ---
  var sm = document.getElementById('override-split-mode');
  if (sm) sm.addEventListener('change', function() {
    var mc = document.getElementById('manual-segments-container');
    if (mc) mc.style.display = this.value === 'manual' ? 'block' : 'none';
    updateSplitModeFields();
    triggerSplitPreview();
  });
  // Run on page load to set initial state
  updateSplitModeFields();
  var maxSeg = document.getElementById('override-max-segments');
  if (maxSeg) maxSeg.addEventListener('change', triggerSplitPreview);
  var udhFmt = document.getElementById('override-udh-format');
  if (udhFmt) udhFmt.addEventListener('change', triggerSplitPreview);
  var ovrDc = document.getElementById('def-data-coding');
  if (ovrDc) ovrDc.addEventListener('change', triggerSplitPreview);
});

// =============================================================================
// Updates
// =============================================================================

// --- We removed the duplicate split-preview/encoding listeners and consolidated
//     them into the main send-message input handler at line 418. ---

// --- Clear Log ---
document.getElementById('btn-clear-log').addEventListener('click', function () {
  state.logs = [];
  renderLogs();
  addLogEntry('info', 'Event log cleared');
});

// --- Clear Inbox ---
document.getElementById('btn-clear-inbox').addEventListener('click', function () {
  state.incomingMessages = [];
  renderIncomingMessages();
  addLogEntry('info', 'Inbox cleared');
});

// --- Clear DLR ---
document.getElementById('btn-clear-dlr').addEventListener('click', function () {
  state.deliveryReports = [];
  renderDeliveryReports();
  addLogEntry('info', 'Delivery reports cleared');
});

// =============================================================================
// Initial Load
// =============================================================================
document.addEventListener('DOMContentLoaded', function () {
  socket.emit('config:get_defaults');
  socket.emit('inbox:get');
  socket.emit('dlr:get');
  // Set destination mode initial visibility
  const destMode = document.getElementById('send-destination-mode');
  if (destMode) {
    const mode = destMode.value;
    const singleGroup = document.getElementById('destination-single-group');
    const multipleGroup = document.getElementById('dest-multiple-group');
    if (mode === 'batch' || mode === 'multiple') {
      if (singleGroup) singleGroup.classList.add('hidden');
      if (multipleGroup) multipleGroup.classList.remove('hidden');
    } else {
      if (singleGroup) singleGroup.classList.remove('hidden');
      if (multipleGroup) multipleGroup.classList.add('hidden');
    }
  }
  // Set cancel-by initial visibility
  const cancelBy = document.getElementById('cancel-by');
  if (cancelBy) {
    const by = cancelBy.value;
    const msgIdGroup = document.getElementById('cancel-message-id-group');
    const srcDestGroup = document.getElementById('cancel-source-dest-group');
    if (by === 'message_id') {
      if (msgIdGroup) msgIdGroup.classList.remove('hidden');
      if (srcDestGroup) srcDestGroup.classList.add('hidden');
    } else if (by === 'source_dest') {
      if (msgIdGroup) msgIdGroup.classList.add('hidden');
      if (srcDestGroup) srcDestGroup.classList.remove('hidden');
    }
  }
  // Initialize stats display
  updateStatsDisplay();
  
  // Clear Form button
  var clearForm = document.getElementById('btn-clear-form');
  if (clearForm) clearForm.addEventListener('click', function() {
    document.getElementById('send-destination').value = '';
    document.getElementById('send-message').value = '';
    document.getElementById('send-destinations').value = '';
    document.getElementById('char-current').textContent = '0';
    document.getElementById('char-limit').textContent = '160';
    document.getElementById('char-parts').textContent = '';
  });
});
