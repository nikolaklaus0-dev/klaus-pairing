# KLAUS-XMD Pairing Server

Generates short `KLAUS XMD:<20-char-code>` session IDs for the KLAUS-XMD WhatsApp bot.

## How it works

```
┌──────────────────────┐      ┌──────────────────────┐
│  User opens pairing  │      │  Server creates     │
│  site in browser     │ ───▶ │  Baileys session     │
└──────────────────────┘      └──────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Server emits QR      │
                              │  via WebSocket        │
                              └──────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  User scans QR with   │
                              │  WhatsApp             │
                              └──────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Baileys connects    │
                              │  creds captured       │
                              └──────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Server gzips +      │
                              │  base64-encodes creds │
                              │  → "KLAUS XMD:H4sI..." │
                              │  (the FULL session)   │
                              └──────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Server generates    │
                              │  20-char short code  │
                              │  Stores full session │
                              │  → returns code to   │
                              │  user                │
                              └──────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  User sees:          │
                              │  KLAUS XMD:<code>    │
                              │  (30 chars total)    │
                              └──────────────────────┘
```

Then later, when the bot starts:

```
┌──────────────────────┐      ┌──────────────────────┐
│  Bot reads SESSION_ID│      │  Bot validates       │
│  from .env           │ ───▶ │  "KLAUS XMD:" prefix │
│  "KLAUS XMD:<code>"  │      │  + length ≤ 30 chars │
└──────────────────────┘      └──────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Bot fetches         │
                              │  GET /session/<code> │
                              └──────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Server returns      │
                              │  full session:       │
                              │  "KLAUS XMD:H4sI..." │
                              └──────────────────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Bot gunzips, writes │
                              │  creds.json, connects │
                              │  to WhatsApp         │
                              └──────────────────────┘
```

## Setup

### 1. Install dependencies

```bash
cd pairing-server
npm install
```

### 2. Run locally

```bash
npm start
# Server runs on http://localhost:3000
```

### 3. Deploy

The pairing server is a standard Node.js app — deploy it anywhere that supports Node:

- **Render**: push this folder to a GitHub repo, then create a new Web Service
- **Railway**: import the GitHub repo
- **Koyeb**: deploy as a Node.js service
- **VPS**: `git clone && npm install && npm start` (use PM2 for production)

After deploy, point your domain `klausxmdpair.pairsite.space` to the server's URL.

### 4. Update the bot

In the bot's `gift/gmdFunctions.js`, make sure the `serverUrl` points to your deployed pairing server:

```js
const serverUrl = `https://klausxmdpair.pairsite.space/session/${encodeURIComponent(sessionCode)}`;
```

This is already set correctly in the current KLAUS-XMD bot code.

## API

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Frontend UI (QR scan page) |
| `/ws` | WS | WebSocket for live QR + session ID updates |
| `/session/:code` | GET | Returns the full session string for the bot to fetch |
| `/health` | GET | Health check — `{ status, activeSessions, uptime }` |

## Config (via env vars or defaults in server.js)

| Var | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port to listen on |

Hardcoded in `server.js` (change source if you want different values):

| Constant | Value | Description |
|---|---|---|
| `PREFIX` | `"KLAUS XMD:"` | Session ID prefix |
| `CODE_LENGTH` | `20` | Short code length (total ID = 30 chars) |
| `SESSION_TTL_MS` | `1800000` | Session expires after 30 min |

## Tech stack

- **Express** — HTTP server
- **ws** — WebSocket for live updates
- **gifted-baileys** — same Baileys fork the bot uses (100% auth format compatible)
- **qrcode** — render QR as data URL
- **fs-extra** — temp session dir management
- **In-memory Map** — session storage (suitable for single-instance deploy)

## Production notes

- The in-memory session store means sessions are lost if the server restarts. For high-traffic deployments, swap the `Map` for Redis.
- Sessions auto-expire after 30 minutes (configurable in `server.js`).
- Temp Baileys auth folders under `tmp/` are cleaned up after pairing completes or the WebSocket disconnects.
- The QR code is generated per WebSocket connection — each visitor gets a fresh session.
