'use strict';

/**
 * WebSocketHandler — routes Socket.IO client events to SmppManager
 * and broadcasts SmppManager events back to all WebSocket clients.
 *
 * @class
 */
class WebSocketHandler {

  /**
   * @param {import('socket.io').Server} io             Socket.IO server instance
   * @param {import('./smpp-manager')}   smppManager    SMPP session manager
   * @param {object}                     sessionState   Shared application state
   */
  constructor(io, smppManager, sessionState) {
    /** @type {import('socket.io').Server} */
    this.io = io;

    /** @type {import('./smpp-manager')} */
    this.smppManager = smppManager;

    /** @type {object} */
    this.sessionState = sessionState;
  }

  // ===========================================================================
  // Initialisation
  // ===========================================================================

  /**
   * Register all Socket.IO connection handlers and wire SmppManager events.
   */
  initialize() {
    this._registerSocketHandlers();
    this._setupSmppManagerEvents();
  }

  /**
   * Bind the 'connection' event and attach per-socket listeners.
   *
   * @private
   */
  _registerSocketHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`[WebSocket] Client connected: ${socket.id}`);

      // --- SMPC connection lifecycle ---
      socket.on('smsc:connect',        (data) => this.handleSmscConnect(socket, data));
      socket.on('smsc:disconnect',     ()     => this.handleSmscDisconnect(socket));

      // --- Configuration ---
      socket.on('config:get_defaults', ()     => this.handleConfigGetDefaults(socket));
      socket.on('config:update_defaults', (data) => this.handleConfigUpdateDefaults(socket, data));

      // --- Messaging ---
      socket.on('message:send',        (data) => this.handleMessageSend(socket, data));
      socket.on('message:send_batch',  (data) => this.handleMessageSendBatch(socket, data));
      socket.on('message:replace',     (data) => this.handleMessageReplace(socket, data));
      socket.on('message:cancel',      (data) => this.handleMessageCancel(socket, data));

      // --- Encoding ---
      socket.on('encoding:detect',     (data) => this.handleEncodingDetect(socket, data));

      // --- Data retrieval ---
      socket.on('inbox:get',           (data) => this.handleInboxGet(socket, data));
      socket.on('dlr:get',             (data) => this.handleDlrGet(socket, data));

      socket.on('disconnect', () => {
        console.log(`[WebSocket] Client disconnected: ${socket.id}`);
      });
    });
  }

  // ===========================================================================
  // Socket.IO event handlers (Client -> Server)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // smsc:connect
  // ---------------------------------------------------------------------------

  /**
   * Handle client request to connect to an SMSC.
   *
   * @param {import('socket.io').Socket} socket
   * @param {object}                     data
   * @param {string}                     data.host
   * @param {number}                     data.port
   * @param {string}                     data.systemId
   * @param {string}                     data.password
   * @param {string}                     [data.systemType]
   * @param {number}                     [data.windowSize]
   */
  async handleSmscConnect(socket, data) {
    try {
      if (!data || !data.host || !data.port || !data.systemId) {
        socket.emit('smsc:error', {
          message: 'Missing required connection parameters (host, port, systemId)',
          timestamp: this._formatTimestamp(),
        });
        return;
      }

      // Map client field names to what SmppManager.connect() expects
      const smppConfig = {
        host: data.host,
        port: data.port,
        system_id: data.systemId,
        password: data.password || '',
        system_type: data.systemType || '',
        window_size: data.windowSize,
      };

      await this.smppManager.connect(smppConfig);

      // SmppManager.status event will also fire, but we update here explicitly
      this.sessionState.smpp.connected = true;
      this.sessionState.smpp.bound = true;
      this.sessionState.smpp.boundAs = 'transceiver';
      this.sessionState.smpp.sessionId = `sess_${Date.now()}`;
      this.sessionState.smpp.lastConnectedAt = this._formatTimestamp();
      this.sessionState.smpp.lastDisconnectedAt = null;
      this.sessionState.smpp.reconnectAttempts = 0;
      this.sessionState.smpp.error = null;

      socket.emit('smsc:connected', {
        message: 'Successfully connected and bound to SMSC',
        host: data.host,
        port: data.port,
        timestamp: this._formatTimestamp(),
      });
    } catch (err) {
      this.sessionState.smpp.connected = false;
      this.sessionState.smpp.bound = false;
      this.sessionState.smpp.error = err.message;

      socket.emit('smsc:error', {
        message: err.message,
        timestamp: this._formatTimestamp(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // smsc:disconnect
  // ---------------------------------------------------------------------------

  /**
   * Handle client request to disconnect from the SMSC.
   *
   * @param {import('socket.io').Socket} socket
   */
  async handleSmscDisconnect(socket) {
    try {
      await this.smppManager.disconnect();

      this.sessionState.smpp.connected = false;
      this.sessionState.smpp.bound = false;
      this.sessionState.smpp.boundAs = null;
      this.sessionState.smpp.lastDisconnectedAt = this._formatTimestamp();
      this.sessionState.smpp.error = null;

      socket.emit('smsc:disconnected', {
        message: 'Disconnected from SMSC',
        timestamp: this._formatTimestamp(),
      });
    } catch (err) {
      socket.emit('smsc:error', {
        message: `Disconnect failed: ${err.message}`,
        timestamp: this._formatTimestamp(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // config:get_defaults
  // ---------------------------------------------------------------------------

  /**
   * Send the current configuration defaults to the requesting client.
   *
   * @param {import('socket.io').Socket} socket
   */
  handleConfigGetDefaults(socket) {
    try {
      socket.emit('config:defaults', this.sessionState.config);
    } catch (err) {
      socket.emit('config:error', {
        message: `Failed to retrieve defaults: ${err.message}`,
        timestamp: this._formatTimestamp(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // config:update_defaults
  // ---------------------------------------------------------------------------

  /**
   * Merge partial config data into sessionState.config and broadcast
   * the updated defaults to all connected clients.
   *
   * @param {import('socket.io').Socket} socket
   * @param {object}                     data  Partial config fields to merge
   */
  handleConfigUpdateDefaults(socket, data) {
    try {
      if (!data || typeof data !== 'object') {
        socket.emit('config:error', {
          message: 'Invalid config data',
          timestamp: this._formatTimestamp(),
        });
        return;
      }

      // Merge incoming fields, preserving unspecified defaults
      Object.assign(this.sessionState.config, data);

      // Broadcast the full updated config to all clients
      this.broadcastConfig(this.sessionState.config);
    } catch (err) {
      socket.emit('config:error', {
        message: `Failed to update defaults: ${err.message}`,
        timestamp: this._formatTimestamp(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // message:send
  // ---------------------------------------------------------------------------

  /**
   * Send a single SMS message via the SMSC.
   *
   * Client data shape:
   *   { source_addr, destination_addr, short_message, ...overrides }
   *
   * @param {import('socket.io').Socket} socket
   * @param {object}                     data
   */
  async handleMessageSend(socket, data) {
    try {
      if (!data || !data.destination_addr || !data.short_message) {
        socket.emit('message:error', {
          message: 'Missing required fields (destination_addr, short_message)',
          timestamp: this._formatTimestamp(),
        });
        return;
      }

      // Basic sanitisation on the message body
      const sanitised = {
        ...data,
        short_message: this._sanitizeMessage(data.short_message),
      };

      // Merge optional overrides (e.g. data_coding, registered_delivery, etc.)
      const params = { ...sanitised, ...(data.overrides || {}) };

      if (params.source_addr && !this._validateMsisdn(params.destination_addr)) {
        socket.emit('message:error', {
          message: `Invalid destination number: ${params.destination_addr}`,
          timestamp: this._formatTimestamp(),
        });
        return;
      }

      const result = await this.smppManager.sendMessage(params);

      socket.emit('message:sent', {
        message_id: result.message_id,
        sequence_number: result.sequence_number,
        destination: params.destination_addr,
        timestamp: this._formatTimestamp(),
      });
    } catch (err) {
      socket.emit('message:error', {
        message: err.message,
        destination: data ? data.destination_addr : undefined,
        timestamp: this._formatTimestamp(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // message:send_batch
  // ---------------------------------------------------------------------------

  /**
   * Send the same message to multiple destinations.
   *
   * Client data shape:
   *   { destinations: string[], message: string, baseParams?: object }
   *
   * @param {import('socket.io').Socket} socket
   * @param {object}                     data
   */
  async handleMessageSendBatch(socket, data) {
    try {
      if (!data || !data.destinations || !data.message) {
        socket.emit('message:error', {
          message: 'Batch requires "destinations" (array) and "message" (string)',
          timestamp: this._formatTimestamp(),
        });
        return;
      }

      if (!Array.isArray(data.destinations) || data.destinations.length === 0) {
        socket.emit('message:error', {
          message: 'Destinations must be a non-empty array',
          timestamp: this._formatTimestamp(),
        });
        return;
      }

      // Basic validation on each MSISDN
      for (const dest of data.destinations) {
        if (!this._validateMsisdn(dest)) {
          socket.emit('message:error', {
            message: `Invalid phone number: ${dest}`,
            timestamp: this._formatTimestamp(),
          });
          return;
        }
      }

      const batchData = {
        destinations: data.destinations,
        message: this._sanitizeMessage(data.message),
        baseParams: {
          ...(data.baseParams || {}),
          ...(data.overrides || {}),
        },
      };

      const results = await this.smppManager.sendBatch(batchData);

      socket.emit('message:batch_complete', {
        total: results.length,
        results,
        timestamp: this._formatTimestamp(),
      });
    } catch (err) {
      socket.emit('message:error', {
        message: err.message,
        timestamp: this._formatTimestamp(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // message:replace
  // ---------------------------------------------------------------------------

  /**
   * Replace an existing message on the SMSC.
   *
   * @param {import('socket.io').Socket} socket
   * @param {object}                     data
   * @param {string}                     data.message_id
   * @param {string}                     data.source_addr
   * @param {string}                     data.new_message
   */
  async handleMessageReplace(socket, data) {
    try {
      if (!data || !data.message_id || !data.new_message) {
        socket.emit('message:error', {
          message: 'Replace requires message_id and new_message',
          timestamp: this._formatTimestamp(),
        });
        return;
      }

      const params = {
        message_id: data.message_id,
        source_addr: data.source_addr || this.sessionState.config.sourceAddr || '',
        source_addr_ton: data.source_addr_ton,
        source_addr_npi: data.source_addr_npi,
        new_message: this._sanitizeMessage(data.new_message),
      };

      await this.smppManager.replaceMessage(params);

      socket.emit('message:replaced', {
        message_id: data.message_id,
        timestamp: this._formatTimestamp(),
      });
    } catch (err) {
      socket.emit('message:error', {
        message: err.message,
        message_id: data ? data.message_id : undefined,
        timestamp: this._formatTimestamp(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // message:cancel
  // ---------------------------------------------------------------------------

  /**
   * Cancel a pending message on the SMSC.
   *
   * @param {import('socket.io').Socket} socket
   * @param {object}                     data
   * @param {string}                     data.message_id
   */
  async handleMessageCancel(socket, data) {
    try {
      if (!data || !data.message_id) {
        socket.emit('message:error', {
          message: 'Cancel requires message_id',
          timestamp: this._formatTimestamp(),
        });
        return;
      }

      const params = {
        message_id: data.message_id,
        source_addr: data.source_addr || '',
        destination_addr: data.destination_addr || '',
      };

      await this.smppManager.cancelMessage(params);

      socket.emit('message:cancelled', {
        message_id: data.message_id,
        timestamp: this._formatTimestamp(),
      });
    } catch (err) {
      socket.emit('message:error', {
        message: err.message,
        message_id: data ? data.message_id : undefined,
        timestamp: this._formatTimestamp(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // encoding:detect
  // ---------------------------------------------------------------------------

  /**
   * Detect the optimal SMS encoding for a message string.
   *
   * @param {import('socket.io').Socket} socket
   * @param {object}                     data
   * @param {string}                     data.message
   */
  handleEncodingDetect(socket, data) {
    try {
      if (!data || typeof data.message !== 'string') {
        socket.emit('encoding:error', {
          message: 'Encoding detection requires a "message" string',
          timestamp: this._formatTimestamp(),
        });
        return;
      }

      const result = this.smppManager._detectEncoding(data.message);

      socket.emit('encoding:detected', {
        message: data.message,
        encoding: result.encoding,
        data_coding: result.data_coding,
        maxChars: result.maxChars,
        reason: result.reason,
        timestamp: this._formatTimestamp(),
      });
    } catch (err) {
      socket.emit('encoding:error', {
        message: err.message,
        timestamp: this._formatTimestamp(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // inbox:get
  // ---------------------------------------------------------------------------

  /**
   * Return the current list of incoming messages to the requesting client.
   *
   * @param {import('socket.io').Socket} socket
   * @param {object}                     [_data]  Unused, reserved for future filtering
   */
  handleInboxGet(socket, _data) {
    try {
      socket.emit('message:incoming_list', {
        messages: this.sessionState.incomingMessages || [],
        total: (this.sessionState.incomingMessages || []).length,
        timestamp: this._formatTimestamp(),
      });
    } catch (err) {
      socket.emit('message:error', {
        message: `Failed to retrieve inbox: ${err.message}`,
        timestamp: this._formatTimestamp(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // dlr:get
  // ---------------------------------------------------------------------------

  /**
   * Return the current list of delivery reports to the requesting client.
   *
   * @param {import('socket.io').Socket} socket
   * @param {object}                     [_data]  Unused, reserved for future filtering
   */
  handleDlrGet(socket, _data) {
    try {
      socket.emit('message:dlr_list', {
        reports: this.sessionState.deliveryReports || [],
        total: (this.sessionState.deliveryReports || []).length,
        timestamp: this._formatTimestamp(),
      });
    } catch (err) {
      socket.emit('message:error', {
        message: `Failed to retrieve DLRs: ${err.message}`,
        timestamp: this._formatTimestamp(),
      });
    }
  }

  // ===========================================================================
  // Broadcast methods (Server -> Client)
  // ===========================================================================

  /**
   * Broadcast SMSC connection status to all clients.
   *
   * @param {object} data
   */
  broadcastStatus(data) {
    this.io.emit('smsc:status', {
      ...data,
      timestamp: this._formatTimestamp(),
    });
  }

  /**
   * Broadcast configuration defaults to all clients.
   *
   * @param {object} data
   */
  broadcastConfig(data) {
    this.io.emit('config:defaults', {
      ...data,
      timestamp: this._formatTimestamp(),
    });
  }

  /**
   * Broadcast a log / event message to all clients.
   *
   * @param {string} type   Log level (info, warn, error, debug)
   * @param {string} msg    Log message text
   */
  broadcastLog(type, msg) {
    this.io.emit('smpp:event', {
      type,
      timestamp: this._formatTimestamp(),
      message: msg,
    });
  }

  /**
   * Broadcast a message-sent notification to all clients.
   *
   * @param {object} data
   */
  broadcastMessageSent(data) {
    this.io.emit('message:sent', {
      ...data,
      timestamp: this._formatTimestamp(),
    });
  }

  /**
   * Broadcast a message-replaced notification to all clients.
   *
   * @param {object} data
   */
  broadcastMessageReplaced(data) {
    this.io.emit('message:replaced', {
      ...data,
      timestamp: this._formatTimestamp(),
    });
  }

  /**
   * Broadcast a message-cancelled notification to all clients.
   *
   * @param {object} data
   */
  broadcastMessageCancelled(data) {
    this.io.emit('message:cancelled', {
      ...data,
      timestamp: this._formatTimestamp(),
    });
  }

  /**
   * Broadcast an incoming message to all clients.
   *
   * @param {object} data
   */
  broadcastIncomingMessage(data) {
    this.io.emit('message:incoming', {
      ...data,
      timestamp: this._formatTimestamp(),
    });
  }

  /**
   * Broadcast a delivery report to all clients.
   *
   * @param {object} data
   */
  broadcastDlr(data) {
    this.io.emit('message:dlr', {
      ...data,
      timestamp: this._formatTimestamp(),
    });
  }

  /**
   * Broadcast batch send progress to all clients.
   *
   * @param {object} data
   */
  broadcastBatchProgress(data) {
    this.io.emit('message:batch_progress', {
      ...data,
      timestamp: this._formatTimestamp(),
    });
  }

  /**
   * Broadcast encoding detection results to all clients.
   *
   * @param {object} data
   */
  broadcastEncodingDetected(data) {
    this.io.emit('encoding:detected', {
      ...data,
      timestamp: this._formatTimestamp(),
    });
  }

  // ===========================================================================
  // SmppManager event wiring
  // ===========================================================================

  /**
   * Subscribe to SmppManager events and bridge them to the WebSocket layer.
   *
   * @private
   */
  _setupSmppManagerEvents() {
    // --- Status ---
    this.smppManager.on('status', (data) => {
      // Update sessionState based on the status event
      if (data.state === 'connected') {
        this.sessionState.smpp.connected = true;
        this.sessionState.smpp.bound = true;
        this.sessionState.smpp.boundAs = data.bindMode || null;
        this.sessionState.smpp.lastConnectedAt = this._formatTimestamp();
        this.sessionState.smpp.lastDisconnectedAt = null;
        this.sessionState.smpp.reconnectAttempts = 0;
        this.sessionState.smpp.error = null;
      } else if (data.state === 'disconnected') {
        this.sessionState.smpp.connected = false;
        this.sessionState.smpp.bound = false;
        this.sessionState.smpp.boundAs = null;
        this.sessionState.smpp.lastDisconnectedAt = this._formatTimestamp();
        this.sessionState.smpp.error = null;
      } else if (data.state === 'connecting') {
        this.sessionState.smpp.connected = false;
        this.sessionState.smpp.bound = false;
        this.sessionState.smpp.error = null;
      }

      // Ensure stats counter exists
      if (!this.sessionState.smpp.stats) {
        this.sessionState.smpp.stats = 0;
      }

      this.broadcastStatus(data);
      this.broadcastLog(data.state || 'status', `SMSC ${data.state}: ${data.host || ''} ${data.port || ''}`.trim());
    });

    // --- Message sent ---
    this.smppManager.on('message_sent', (data) => {
      if (!this.sessionState.smpp.stats) {
        this.sessionState.smpp.stats = 0;
      }
      this.sessionState.smpp.stats += 1;

      this.broadcastMessageSent(data);
      this.broadcastLog('info', `Message sent to ${data.destination || 'unknown'} [seq=${data.sequence_number}]`);
    });

    // --- Incoming SMS ---
    this.smppManager.on('incoming_sms', (data) => {
      if (!Array.isArray(this.sessionState.incomingMessages)) {
        this.sessionState.incomingMessages = [];
      }
      this.sessionState.incomingMessages.unshift(data);
      // Trim to 100 entries
      if (this.sessionState.incomingMessages.length > 100) {
        this.sessionState.incomingMessages = this.sessionState.incomingMessages.slice(0, 100);
      }

      this.broadcastIncomingMessage(data);
      this.broadcastLog('info', `Incoming SMS from ${data.source_addr || 'unknown'}`);
    });

    // --- DLR received ---
    this.smppManager.on('dlr_received', (data) => {
      if (!Array.isArray(this.sessionState.deliveryReports)) {
        this.sessionState.deliveryReports = [];
      }
      this.sessionState.deliveryReports.unshift(data);
      // Trim to 100 entries
      if (this.sessionState.deliveryReports.length > 100) {
        this.sessionState.deliveryReports = this.sessionState.deliveryReports.slice(0, 100);
      }

      this.broadcastDlr(data);
      this.broadcastLog('info', `DLR received for ${data.message_id || 'unknown'}: ${data.status || 'N/A'}`);
    });

    // --- Message replaced ---
    this.smppManager.on('message_replaced', (data) => {
      this.broadcastMessageReplaced(data);
      this.broadcastLog('info', `Message ${data.message_id || 'unknown'} replaced`);
    });

    // --- Message cancelled ---
    this.smppManager.on('message_cancelled', (data) => {
      this.broadcastMessageCancelled(data);
      this.broadcastLog('info', `Message ${data.message_id || 'unknown'} cancelled`);
    });

    // --- Batch progress ---
    this.smppManager.on('batch_progress', (data) => {
      this.broadcastBatchProgress(data);
    });

    // --- Error ---
    this.smppManager.on('error', (data) => {
      this.broadcastLog('error', data.message || data.error || 'Unknown error');
    });
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Basic international phone number validation.
   * Accepts optional leading '+' followed by 7-15 digits.
   *
   * @param {string} str  Phone number to validate
   * @returns {boolean}
   * @private
   */
  _validateMsisdn(str) {
    if (typeof str !== 'string') return false;
    return /^\+?\d{7,15}$/.test(str.trim());
  }

  /**
   * Sanitise a string for XSS prevention by escaping HTML entities.
   *
   * @param {string} str  Input string
   * @returns {string}
   * @private
   */
  _sanitizeMessage(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * Return an ISO-8601 formatted UTC timestamp string.
   *
   * @returns {string}
   * @private
   */
  _formatTimestamp() {
    return new Date().toISOString();
  }

}

module.exports = WebSocketHandler;
