# SMPP v3.4 Web Client

A full-featured web-based administration tool for SMPP v3.4 SMSC connectivity. Manage SMSC connections, send SMS with UDH concatenation, batch send, view incoming P2A messages and DLRs in real-time — all from a futuristic cyberpunk-styled web UI.

## Features

### SMSC Connection Management
- Connect as **transceiver**, **transmitter**, or **receiver**
- Real-time binding status (disconnected → connecting → connected)
- Encrypted credential entry (no local storage of passwords)
- ENQUIRE_LINK keepalive (30s interval, 5s timeout)

### Send SMS
- **Single Send** — destination + message with configurable defaults
- **Batch Send** — multiple destinations, same message
- **Split Mode (UDH Concatenation)**:
  - **UDH** — auto-splits long messages with GSM 03.38 UDH headers (8-bit or 16-bit reference)
  - **SAR** — Segment Allocation Reference TLVs (SMPP v3.4 standard)
  - **Manual** — define each segment on a new line
  - **No Split** — sends as-is via `message_payload` TLV for >254 bytes
- Live character/segment preview while typing
- **Override Section** — collapseable per-message split mode configuration

### Message Management
- **Replace Message** — `replace_sm` for queued messages
- **Cancel Message** — by message_id or by source+destination pair
- **Inbox** — real-time incoming P2A/MO SMS with timestamps
- **DLR Panel** — delivery receipts with color-coded status + counters

### Split Mode Details

| Mode | Method | Max Chars/Seg (GSM-7) | Max Chars/Seg (UCS-2) |
|---|---|---|---|
| UDH (8-bit ref) | UDH header in message body | 134 | 67 |
| UDH (16-bit ref) | UDH header in message body | 133 | 66 |
| SAR | SMPP SAR TLVs | 160 | 70 |
| Manual | User-defined split | N/A | N/A |
| None | Single PDU (message_payload if >254b) | Unlimited* | Unlimited* |

_* No Split with >254 bytes uses `message_payload` TLV — SMSC support required._

### Auto-Encoding Detection
- **GSM-7 Default Alphabet** (data_coding=0) — all standard GSM characters
- **UCS-2** (data_coding=8) — triggered by emoji, Arabic script, or any non-GSM-7 character
- **Manual override** via defaults panel (set data_coding to 1, 3, or 8 to force encoding)

### Throughput Sender
- **Rate-controlled burst sending** — set rate from 1–100 msg/s
- **Total count expansion** — repeats destinations cyclically to hit exact count
- **Per-second rate limiting** — maintains constant rate (no auto-reduction)
- **Auto-pause on throttling** — pauses after 10 consecutive ESME_RTHROTTLED errors
- **Smart retry** — re-queues throttled messages; non-throttle errors fail immediately
- **Pause / Resume / Stop** — full job lifecycle control
- **Real-time progress** — sent/failed counters, ETA, target rate display
- **Error summary** — lists real SMSC errors (invalid dest, auth, etc.) in a collapsible panel

## Architecture

```
┌─────────────┐     WebSocket      ┌──────────────────────────────────┐
│   Browser   │ ◄─── Socket.IO ──► │         Node.js Backend          │
│  (HTML/CSS/ │                    │  ┌──────────┐  ┌──────────────┐  │
│   Vanilla   │                    │  │ Express  │  │ SmppManager  │  │
│   JS/ES6)   │                    │  │ Server   │  │ - Session    │  │
└─────────────┘                    │  │ (server) │  │ - Windowing  │  │
                                   │  └──────────┘  │ - Encoding   │  │
                                   │                 │ - Split/UDH  │  │
                                   │  ┌──────────┐  │ - Enquire    │  │
                                   │  │WebSocket │  │ - DLR/P2A   │  │
                                   │  │ Handler  │  └──────┬───────┘  │
                                   │  └──────────┘         │          │
                                   └───────────────────────┼──────────┘
                                                           │ TCP 2775
                                                           ▼
                                                    ┌─────────────┐
                                                    │    SMSC     │
                                                    │  SMPP v3.4  │
                                                    └─────────────┘
```

### File Structure

```
smpp-web-client/
├── server.js                    # Express + Socket.IO entry point
├── lib/
│   ├── smpp-manager.js          # SMPP protocol: connect, bind, send, split, DLR
│   ├── websocket-handler.js     # Socket.IO event routing + state management
│   └── defaults-helper.js       # SMSC defaults merge helpers
├── public/
│   ├── index.html               # UI structure (8 panels)
│   ├── app.js                   # Frontend logic + Socket.IO handlers
│   └── style.css                # Cyberpunk glass-morphism theme
├── .env.example                 # Environment variable template
├── package.json                 # Dependencies
├── README.md                    # This file
├── smsc-simulator.js            # Standalone SMSC simulator for testing
└── test-*.js                    # Test suites (see Testing section)
```

## Quick Start

```bash
git clone https://github.com/mfrihi/smpp-web-client.git
cd smpp-web-client
cp .env.example .env
# Edit .env with your SMSC credentials
npm install
npm start
```

Open **http://localhost:3000** in your browser.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SMPP_HOST` | 127.0.0.1 | SMSC hostname/IP |
| `SMPP_PORT` | 2775 | SMSC TCP port |
| `SMPP_SYSTEM_ID` | your_username | SMPP username |
| `SMPP_PASSWORD` | your_password | SMPP password |
| `SMPP_SYSTEM_TYPE` | (empty) | Optional system type |
| `SMPP_SOURCE_ADDR` | MyApp | Default source address |
| `PORT` | 3000 | HTTP server port |
| `NODE_ENV` | development | Environment mode |
| `SMPP_WINDOW_SIZE` | 10 | Max unacknowledged submit_sm |
| `SMPP_ENQUIRE_LINK_INTERVAL_MS` | 30000 | Keepalive interval |
| `SMPP_MESSAGE_TIMEOUT_MS` | 60000 | Per-message submit timeout |
| `SMPP_MAX_BATCH_SIZE` | 100 | Max destinations per batch |
| `SMPP_MAX_SEGMENTS` | 10 | Max UDH/SAR segments per message |

## Deployment (Production)

### Using PM2

```bash
npm install -g pm2
cp .env.example .env
# Configure .env with production SMSC
npm install
pm2 start server.js --name smpp-client
pm2 save
pm2 startup
```

### Behind Nginx (WebSocket)

```nginx
location /smpp-client/ {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_cache_bypass $http_upgrade;
}
```

### Systemd Service

```ini
[Unit]
Description=SMPP Web Client
After=network.target

[Service]
Type=simple
User=node
WorkingDirectory=/opt/smpp-web-client
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## UI Panels

| Panel | Purpose |
|---|---|
| **SMSC Connection** | Host/port/credentials, CONNECT/DISCONNECT, status indicator |
| **Message Defaults** | Persistent defaults: source addr, TON/NPI, data coding, priority, DLR, message class |
| **Send Message** | Destination MSISDN + message text + character counter + split preview |
| **Batch Send** | Multiple destinations (newline-separated) + same message |
| **Throughput Sender** | Rate-controlled burst sending with pause/resume/stop, progress bar, ETA, error summary |
| **Replace Message** | `replace_sm` by message_id |
| **Cancel Message** | `cancel_sm` by message_id or source+destination |
| **Event Log** | Real-time color-coded protocol events (last 1000) |
| **Inbox / DLR** | Incoming P2A SMS + delivery receipts with counters |

## WebSocket API

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `smsc:connect` | `{host, port, system_id, password, system_type, bind_mode}` | Establish SMPP connection |
| `smsc:disconnect` | `{}` | Close SMPP session |
| `config:get_defaults` | `{}` | Retrieve current defaults |
| `config:update_defaults` | `{source_addr, data_coding, ...}` | Update persistent defaults |
| `message:send` | `{destination_addr, short_message, overrides?}` | Send SMS (overrides: split_mode, max_segments, udh_format) |
| `message:send_batch` | `{destinations: string[], short_message, baseParams?}` | Batch send |
| `message:replace` | `{message_id, source_addr, new_message}` | Replace queued message |
| `message:cancel` | `{cancel_by, message_id?, source_addr?, destination_addr?}` | Cancel message |
| `encoding:detect` | `{text}` | Detect GSM-7 or UCS-2 |
| `throughput:start` | `{destinations, message, ratePerSecond, totalCount, overrides?}` | Start burst send job |
| `throughput:pause` | `{jobId}` | Pause running job |
| `throughput:resume` | `{jobId}` | Resume paused job |
| `throughput:stop` | `{jobId}` | Stop job immediately |
| `throughput:update_rate` | `{jobId, newRate}` | Change rate during job |
| `throughput:status` | `{jobId}` | Get current job status |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `smsc:status` | `{state, host?, port?, bindMode?, connected_since?}` | Connection state change |
| `config:defaults` | `{source_addr, data_coding, ...}` | Current defaults |
| `message:sent` | `{message_id, destination, segment?, total_segments?}` | Submit success |
| `message:error` | `{message, destination?}` | Submit failure |
| `message:replaced` | `{success, original_message_id, ...}` | Replace result |
| `message:cancelled` | `{success, message_id, ...}` | Cancel result |
| `message:incoming` | `{source_addr, destination_addr, short_message, ...}` | P2A/MO SMS |
| `message:dlr` | `{message_id, status, done_date, stat, ...}` | Delivery receipt |
| `smpp:event` | `{type, message, pdu?}` | Protocol log event |
| `encoding:detected` | `{encoding, data_coding, max_chars, reason}` | Encoding detection result |
| `message:incoming_list` | `{messages: [...]}` | Inbox history (on connect) |
| `message:dlr_list` | `{reports: [...]}` | DLR history (on connect) |
| `throughput:started` | `{jobId, totalCount, rate}` | Job started |
| `throughput:progress` | `{jobId, sent, failed, total, percentage, currentRate, targetRate, eta}` | Job progress update |
| `throughput:paused` | `{jobId, reason}` | Job paused (user or auto) |
| `throughput:resumed` | `{jobId, rate}` | Job resumed |
| `throughput:stopped` | `{jobId, sent, failed}` | Job stopped |
| `throughput:completed` | `{jobId, sent, failed, total, duration}` | Job completed |
| `throughput:error` | `{jobId, errorType, errorCode, errorMessage, destination?}` | SMSC error during job |
| `throughput:rate_updated` | `{jobId, oldRate, newRate}` | Rate changed |

## SMPP Protocol Support

### Supported PDUs

| PDU | Direction | Status |
|---|---|---|
| `bind_transceiver` / `_resp` | Client ↔ SMSC | ✅ |
| `bind_transmitter` / `_resp` | Client ↔ SMSC | ✅ |
| `bind_receiver` / `_resp` | Client ↔ SMSC | ✅ |
| `unbind` / `_resp` | Client ↔ SMSC | ✅ |
| `enquire_link` / `_resp` | Client ↔ SMSC | ✅ |
| `submit_sm` / `_resp` | Client → SMSC | ✅ |
| `replace_sm` / `_resp` | Client → SMSC | ✅ |
| `cancel_sm` / `_resp` | Client → SMSC | ✅ |
| `deliver_sm` / `_resp` | SMSC → Client | ✅ |
| `generic_nack` | Either | ✅ |

### Message Encoding Limits

| data_coding | Encoding | Single | UDH 8-bit | UDH 16-bit |
|---|---|---|---|---|
| 0x00 | GSM-7 Default | 160 | 134 | 133 |
| 0x01 | ASCII | 160 | 134 | 133 |
| 0x03 | Latin-1 | 140 | 134 | 133 |
| 0x08 | UCS-2 | 70 | 67 | 66 |

### Error Code Reference

| Code | Name | Meaning |
|---|---|---|
| 0x00 | ESME_ROK | Success |
| 0x0D | ESME_RINVCMDID | Unknown command |
| 0x0E | ESME_RINVSRCADDR | Invalid source address |
| 0x0F | ESME_RINVDSTADDR | Invalid destination |
| 0x14 | ESME_RINVMSGID | Invalid message ID |
| 0x19 | ESME_RTHROTTLED | Sending too fast |
| 0x58 | ESME_RBINDFAIL | Authentication failed |
| 0x68 | _VENDOR_ | Source not whitelisted / permission issue |

## Testing

### SMSC Simulator

A built-in SMSC simulator for development testing:

```bash
node smsc-simulator.js
# Listens on port 2775 (default)
```

Then connect from the web UI at `localhost:2775` with any credentials.

### Test Suites

| File | Purpose |
|---|---|
| `test-e2e.js` | End-to-end submit_sm and replace_sm |
| `test-comprehensive.js` | Full feature test suite |
| `test-dlr-e2e.js` | DLR delivery receipt flow |
| `test-p2a-e2e.js` | Incoming P2A SMS flow |
| `test-nosplit-e2e.js` | No Split (message_payload TLV) |
| `test-message-payload.js` | Large message payload testing |
| `test-schedule-formats.js` | Scheduled delivery format testing |
| `test-validity-formats.js` | Validity period format testing |
| `test-bind-modes.js` | Transmitter/receiver/transceiver bind |
| `test-ws-quick.js` | Quick WebSocket connectivity test |

```bash
npm test                # Run all tests
node test-e2e.js        # Single test suite
```

## Technical Notes

- **UDHL byte**: The UDH header requires the User Data Header Length byte as the first byte. Without it, the phone treats UDH bytes as message content.
- **7-bit packing**: The smpp library stores text as raw 8-bit bytes; 7-bit packing is handled by the SMSC/handset based on `data_coding`. Our code does NOT perform 7-bit packing internally to match library behavior.
- **Sequence numbers**: A template sequence number is consumed during split detection — sent segments use independent sequence numbers starting at the next available.
- **Window flow control**: Max 10 outstanding submit_sm requests. Batch sends respect window capacity with `_waitForWindow()`.
- **Cache busting**: Static files are served with `Cache-Control: no-store` and queried via `?v=...` parameter for quick deployment updates.

## License

MIT
