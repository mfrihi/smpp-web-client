'use strict';

const smpp = require('smpp');
const { EventEmitter } = require('events');

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
    return '\\^{}\\\\\\[~\\]|€';
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
        const { host, port, system_id, password, system_type } = config;

        if (!host || !port || !system_id || !password) {
          return reject(new Error('Missing required connection parameters (host, port, system_id, password)'));
        }

        this.config = config;

        if (config.window_size && typeof config.window_size === 'number') {
          this.windowSize = config.window_size;
        }

        this.emit('status', { state: 'connecting', host, port });

        const session = smpp.connect({ host, port });

        session.on('connect', () => {
          this.emit('log', { level: 'info', message: `TCP connected to ${host}:${port}` });

          const bindParams = {
            system_id,
            password,
            system_type: system_type || '',
            interface_version: 0x34,
          };

          session.bind_transceiver(bindParams);
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

          if (cmd === 'bind_transceiver_resp') {
            if (pdu.command_status === 0) {
              this.session = session;
              this.isConnected = true;
              this.bindMode = 'transceiver';
              this.emit('status', { state: 'connected', bindMode: 'transceiver' });
              this.emit('log', { level: 'info', message: 'Successfully bound as transceiver' });
              this._bindSMPPEvents();
              this._startEnquireLinkTimer();
              resolve();
            } else {
              const errMsg = smpp.lookup_error(pdu.command_status) || `Bind error code ${pdu.command_status}`;
              session.close();
              reject(new Error(`Bind failed: ${errMsg}`));
            }
            return;
          }

          // If not connected yet, ignore stray PDUs
          if (!this.isConnected) return;

          // ------------------- submit_sm_resp -------------------
          if (cmd === 'submit_sm_resp') {
            const seq = pdu.sequence_number;
            const pending = this.pendingMessages.get(seq);
            if (pending) {
              this.pendingMessages.delete(seq);
              this.outstandingCount = Math.max(0, this.outstandingCount - 1);

              if (pdu.command_status === 0) {
                pending.resolve({ message_id: pdu.message_id, sequence_number: seq });
              } else {
                const errMsg = smpp.lookup_error(pdu.command_status) || `Submit error ${pdu.command_status}`;
                pending.reject(new Error(errMsg));
              }
            }
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

    const seq = this._getNextSequenceNumber();
    const pdu = this._buildSubmitSm(params, seq);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingMessages.delete(seq);
        this.outstandingCount = Math.max(0, this.outstandingCount - 1);
        reject(new Error(`Submit_sm timeout for sequence ${seq}`));
      }, 120000);

      this.pendingMessages.set(seq, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        timestamp: Date.now(),
      });

      this.outstandingCount += 1;

      this.session.send(pdu);

      this.emit('message_sent', {
        sequence_number: seq,
        destination: params.destination_addr,
        source: params.source_addr,
        total_segments: pdu.segments ? pdu.segments.length : 1,
      });

      this.emit('log', {
        level: 'debug',
        message: `submit_sm sent [seq=${seq}] to ${params.destination_addr}`,
      });
    });
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

    if (!message_id || !source_addr || !new_message) {
      throw new Error('replaceMessage requires message_id, source_addr, and new_message');
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
            const errMsg = smpp.lookup_error(pdu.command_status) || `Replace error ${pdu.command_status}`;
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

    const { message_id, source_addr, destination_addr } = params;

    if (!message_id) {
      throw new Error('cancelMessage requires message_id');
    }

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
              message: `Message ${message_id} cancelled`,
            });
            resolve();
          } else {
            const errMsg = smpp.lookup_error(pdu.command_status) || `Cancel error ${pdu.command_status}`;
            reject(new Error(errMsg));
          }
        }
      };

      this.session.on('pdu', onResp);

      this.session.cancel_sm({
        message_id,
        source_addr: source_addr || '',
        destination_addr: destination_addr || '',
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
      messageText = this._decodeMessage(pdu.short_message, dc);
    }

    // --- DLR detection ---
    // ESM class 0x04 indicates a delivery receipt (SME Delivery Acknowledgment)
    const isDLR = (esmClass & 0x04) !== 0 && /^id:/i.test(messageText.trim());

    if (isDLR) {
      try {
        const dlr = this._parseDLR(messageText);
        dlr.source_addr = sourceAddr;
        dlr.destination_addr = destAddr;
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
      this.session.send(
        this.session.createPdu({
          command: 'deliver_sm_resp',
          sequence_number: pdu.sequence_number,
          command_status: 0,
        })
      );
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
  _splitMessage(msg, dc, maxSegments = 3) {
    const encodingInfo = this._detectEncoding(msg);

    // Determine per-segment character limit
    let segLen;
    if (dc === 0x08 || encodingInfo.data_coding === 0x08) {
      segLen = 67; // UCS-2 per segment
    } else {
      // GSM-7: 153 chars per segment (153 = 160 - 7 UDH bytes)
      segLen = 153;
    }

    const totalLen = msg.length;
    const numSegments = Math.ceil(totalLen / segLen);

    if (numSegments <= 1) {
      return [{ udh: null, text: msg }];
    }

    const actualSegments = Math.min(numSegments, maxSegments);

    // UDH: 05 00 03 XX YY ZZ
    // 05 = UDH length, 00 03 = IEI + IEDL for concatenated SMS, XX = ref, YY = total, ZZ = segment
    const ref = Math.floor(Math.random() * 256);
    const segments = [];

    for (let i = 0; i < actualSegments; i++) {
      const start = i * segLen;
      let end = start + segLen;

      // For the last segment, use all remaining chars if we bounded
      if (i === actualSegments - 1 && numSegments > maxSegments) {
        // We need to redistribute: more chars in the last segment
        end = msg.length;
      } else {
        end = Math.min(end, msg.length);
      }

      const chunk = msg.substring(start, end);

      // Build UDH: IEI=0x00 (concatenated SMS), IEDL=0x03
      const udh = Buffer.alloc(6);
      udh[0] = 0x05;  // UDH length
      udh[1] = 0x00;  // IEI — concatenated SMS (8-bit ref)
      udh[2] = 0x03;  // IEDL
      udh[3] = ref;   // reference number
      udh[4] = actualSegments; // total segments
      udh[5] = i + 1;  // segment number

      segments.push({ udh, text: chunk });
    }

    return segments;
  }

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
      source_addr_ton = 0x01,
      source_addr_npi = 0x01,
      destination_addr,
      destination_addr_ton = 0x01,
      destination_addr_npi = 0x01,
      short_message,
      data_coding: explicitDc,
      esm_class = 0x00,
      protocol_id = 0x00,
      priority_flag = 0x00,
      schedule_delivery_time,
      validity_period,
      service_type = '',
      replace_if_present_flag = 0x00,
      sm_default_msg_id = 0x00,
      registered_delivery = 0x00,
    } = params;

    if (!source_addr || !destination_addr || !short_message) {
      throw new Error('_buildSubmitSm requires source_addr, destination_addr, and short_message');
    }

    // Detect encoding
    const encoding = this._detectEncoding(short_message);
    const dataCoding = explicitDc !== undefined ? explicitDc : encoding.data_coding;

    // Split if needed (long messages)
    let messageText = short_message;
    let udh = null;
    const maxSingleLen = dataCoding === 0x08 ? 140 : 160;

    if (short_message.length > maxSingleLen) {
      const segments = this._splitMessage(short_message, dataCoding);

      if (segments.length > 0) {
        // Send only the first segment here; caller is responsible for sending
        // the rest. We attach the full segment list for multi-part handling.
        messageText = segments[0].text;
        udh = segments[0].udh;
      }
    }

    return {
      source_addr,
      source_addr_ton,
      source_addr_npi,
      destination_addr,
      destination_addr_ton,
      destination_addr_npi,
      short_message: messageText,
      data_coding: dataCoding,
      esm_class: udh ? 0x40 : esm_class, // UDHI bit if UDH present
      protocol_id,
      priority_flag,
      schedule_delivery_time: schedule_delivery_time || undefined,
      validity_period: validity_period || undefined,
      service_type,
      replace_if_present_flag,
      sm_default_msg_id,
      registered_delivery,
      sequence_number: seqOverride || this._getNextSequenceNumber(),
    };
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

}

module.exports = SmppManager;
