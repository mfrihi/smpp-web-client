'use strict';

// =============================================================================
// SMPP Web Client — Express + Socket.IO Server Entry Point
// =============================================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Load environment variables from the project root .env file
const envPath = path.resolve(__dirname, '.env');
dotenv.config({ path: envPath });

const PORT = parseInt(process.env.PORT, 10) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ---------------------------------------------------------------------------
// Shared State
// ---------------------------------------------------------------------------

/**
 * sessionState — the single source of truth shared across all modules.
 *
 * @property {object}   smpp              - Current SMPP connection status
 * @property {object}   config            - Active SMPP configuration defaults
 * @property {Array}    incomingMessages  - Accumulated incoming SMS messages
 * @property {Array}    deliveryReports   - Accumulated delivery receipts
 * @property {Array}    logs              - Application log buffer
 */
const sessionState = {
  smpp: {
    connected: false,
    bound: false,
    boundAs: null,          // 'transmitter' | 'receiver' | 'transceiver'
    sessionId: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    reconnectAttempts: 0,
    error: null,
  },
  config: {
    host: process.env.SMPP_HOST || '127.0.0.1',
    port: parseInt(process.env.SMPP_PORT, 10) || 2775,
    systemId: process.env.SMPP_SYSTEM_ID || '',
    password: process.env.SMPP_PASSWORD || '',
    systemType: process.env.SMPP_SYSTEM_TYPE || '',
    sourceAddr: process.env.SMPP_SOURCE_ADDR || 'MyApp',
    windowSize: parseInt(process.env.SMPP_WINDOW_SIZE, 10) || 10,
    enquireLinkIntervalMs: parseInt(process.env.SMPP_ENQUIRE_LINK_INTERVAL_MS, 10) || 30000,
    enquireLinkTimeoutMs: parseInt(process.env.SMPP_ENQUIRE_LINK_TIMEOUT_MS, 10) || 5000,
    messageTimeoutMs: parseInt(process.env.SMPP_MESSAGE_TIMEOUT_MS, 10) || 60000,
    reconnectAttempts: parseInt(process.env.SMPP_RECONNECT_ATTEMPTS, 10) || 3,
    reconnectDelayMs: parseInt(process.env.SMPP_RECONNECT_DELAY_MS, 10) || 5000,
    maxBatchSize: parseInt(process.env.SMPP_MAX_BATCH_SIZE, 10) || 100,
    maxSegments: parseInt(process.env.SMPP_MAX_SEGMENTS, 10) || 10,
  },
  incomingMessages: [],
  deliveryReports: [],
  logs: [],
};

// ---------------------------------------------------------------------------
// Express App Setup
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static front-end files with no-cache headers
app.use(express.static(path.resolve(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: function (res, path) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
}));

// ---------------------------------------------------------------------------
// Request Logging Middleware
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  next();
});

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/health
 * Lightweight health-check endpoint.
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * GET /api/state
 * Returns the current session state (read-only).
 */
app.get('/api/state', (req, res) => {
  res.json(sessionState);
});

// ---------------------------------------------------------------------------
// SMPP Manager — M2
// =============================================================================
const SmppManager = require('./lib/smpp-manager');
const smppManager = new SmppManager();

// =============================================================================
// WebSocket Handler — M3
// =============================================================================
const WebSocketHandler = require('./lib/websocket-handler');
const wsHandler = new WebSocketHandler(io, smppManager, sessionState);
wsHandler.initialize();

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

// API 404 handler — caught before the SPA fallback below
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.url} not found`,
  });
});

// Fallback: serve index.html for SPA-style routing (non-API paths)
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] Unhandled error:`, err);

  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    ...(NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ---------------------------------------------------------------------------
// Server Startup
// ---------------------------------------------------------------------------

/**
 * startServer — binds the HTTP server and logs startup info.
 */
async function startServer() {
  return new Promise((resolve, reject) => {
    server.listen(PORT, () => {
      console.log(`\n============================================`);
      console.log(`  SMPP Web Client v2.0`);
      console.log(`  Environment : ${NODE_ENV}`);
      console.log(`  Port        : ${PORT}`);
      console.log(`  Static dir  : /var/www/smpp-client/public`);
      console.log(`  Health      : http://localhost:${PORT}/api/health`);
      console.log(`============================================\n`);

      sessionState.logs.push({
        level: 'info',
        message: `Server started on port ${PORT} (${NODE_ENV})`,
        timestamp: new Date().toISOString(),
      });

      resolve(server);
    });

    server.once('error', (err) => {
      console.error(`[FATAL] Failed to start server on port ${PORT}:`, err.message);
      reject(err);
    });
  });
}

// Auto-start only when run directly (not required as a module)
if (require.main === module) {
  startServer().catch((err) => {
    console.error('Server startup failed:', err);
    process.exit(1);
  });
}

// =============================================================================
// Exports
// =============================================================================

module.exports = { app, server, io, sessionState, config: sessionState.config };
