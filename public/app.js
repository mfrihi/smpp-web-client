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
  batchState: null
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
  const fieldMappings = {
    'override-source-addr': 'source_addr',
    'override-source-ton': 'source_addr_ton',
    'override-source-npi': 'source_addr_npi',
    'override-data-coding': 'data_coding',
    'override-message-class': 'message_class'
  };
  for (const [elId, key] of Object.entries(fieldMappings)) {
    const el = document.getElementById(elId);
    if (el && state.defaults[key] !== undefined) {
      el.value = state.defaults[key];
    }
  }
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
  const tbody = document.getElementById('inbox-entries');
  if (!tbody) return;
  let html = '';
  for (const msg of state.incomingMessages) {
    const time = formatTime(msg.received_at || msg.time);
    const isRtl = detectRtl(msg.short_message || msg.text || '');
    const dir = isRtl ? ' dir="rtl"' : '';
    const displayText = truncate(msg.short_message || msg.text || '', 160);
    html += '<tr>';
    html += '<td>' + escapeHtml(time) + '</td>';
    html += '<td>' + escapeHtml(msg.source_addr || msg.source || '') + '</td>';
    html += '<td>' + escapeHtml(msg.destination_addr || msg.destination || '') + '</td>';
    html += '<td' + dir + '>' + escapeHtml(displayText) + '</td>';
    html += '</tr>';
  }
  tbody.innerHTML = html;
}

/**
 * Render delivery reports into the DLR table with color-coded status badges.
 */
function renderDeliveryReports() {
  const tbody = document.getElementById('dlr-entries');
  if (!tbody) return;
  let html = '';
  for (const dlr of state.deliveryReports) {
    const time = formatTime(dlr.received_at || dlr.time);
    const status = (dlr.stat || dlr.status || '').toLowerCase();
    let badgeClass = 'badge badge-';
    let badgeText = escapeHtml(dlr.stat || dlr.status || 'UNKNOWN');
    // Color-code status badges
    if (status === 'delivered' || status === 'delivrd') {
      badgeClass += 'success';
    } else if (status === 'failed' || status === 'undeliv' || status === 'rejected') {
      badgeClass += 'danger';
    } else if (status === 'expired' || status === 'deleted') {
      badgeClass += 'warning';
    } else if (status === 'accepted' || status === 'enroute' || status === 'accepted') {
      badgeClass += 'info';
    } else {
      badgeClass += 'secondary';
    }
    html += '<tr>';
    html += '<td>' + escapeHtml(time) + '</td>';
    html += '<td>' + escapeHtml(dlr.message_id || '') + '</td>';
    html += '<td>' + escapeHtml(dlr.source_addr || dlr.source || '') + '</td>';
    html += '<td>' + escapeHtml(dlr.destination_addr || dlr.destination || '') + '</td>';
    html += '<td><span class="' + badgeClass + '">' + badgeText + '</span></td>';
    html += '<td>' + escapeHtml(dlr.error_code || '') + '</td>';
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
// Socket Event Handlers
// =============================================================================

socket.on('smsc:status', function (data) {
  const indicator = document.getElementById('status-indicator');
  const text = document.getElementById('status-text');
  const connectBtn = document.getElementById('btn-connect');
  const disconnectBtn = document.getElementById('btn-disconnect');
  const status = data && data.status ? data.status : 'disconnected';
  state.smscStatus = status;
  // Update indicator class
  if (indicator) {
    indicator.className = 'status-indicator';
    if (status === 'connected' || status === 'bound') {
      indicator.classList.add('status-connected');
    } else if (status === 'connecting' || status === 'binding') {
      indicator.classList.add('status-connecting');
    } else {
      indicator.classList.add('status-disconnected');
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
    'def-sm-default-msg': 'sm_default_msg_id'
  };
  for (const [elId, key] of Object.entries(fieldMappings)) {
    const el = document.getElementById(elId);
    if (el && data[key] !== undefined) {
      el.value = data[key];
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
  addLogEntry('info', 'DLR received for message: ' + (data.message_id || 'unknown'));
});

socket.on('message:batch_progress', function (data) {
  if (!data) return;
  state.batchState = data;
  renderBatchProgress();
  if (data.complete) {
    addLogEntry('success', 'Batch complete: ' + (data.sent || 0) + ' messages sent');
  } else if (data.error) {
    addLogEntry('error', 'Batch error: ' + data.error);
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
});

socket.on('smpp:event', function (data) {
  if (!data) return;
  addLogEntry(data.type || 'info', data.message || data.msg || 'SMPP event');
});

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
    'def-sm-default-msg': 'sm_default_msg_id'
  };
  const data = {};
  for (const [elId, key] of Object.entries(fieldMappings)) {
    const el = document.getElementById(elId);
    if (el) {
      data[key] = el.value;
    }
  }
  return data;
}

function gatherOverrideValues() {
  const fieldMappings = {
    'source-addr': 'source_addr',
    'source-ton': 'source_addr_ton',
    'source-npi': 'source_addr_npi',
    'data-coding': 'data_coding',
    'message-class': 'message_class'
  };
  const data = {};
  for (const [elSuffix, key] of Object.entries(fieldMappings)) {
    const el = document.getElementById('override-' + elSuffix);
    if (el) {
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
  'def-protocol-id', 'def-replace-if-present', 'def-sm-default-msg'
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

// --- Real-time encoding detection (also fires on mobile via input/keyup) ---
var sendMsgEl = document.getElementById('send-message');
if (sendMsgEl) {
  sendMsgEl.addEventListener('input', function() { socket.emit('encoding:detect', { text: this.value }); });
  sendMsgEl.addEventListener('keyup', function() { socket.emit('encoding:detect', { text: this.value }); });
  sendMsgEl.addEventListener('change', function() { socket.emit('encoding:detect', { text: this.value }); });
}

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
});

// --- Clear Log ---
document.getElementById('btn-clear-log').addEventListener('click', function () {
  state.logs = [];
  renderLogs();
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
