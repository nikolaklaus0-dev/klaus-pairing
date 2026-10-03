/**
 * KLAUS-XMD Pairing Server
 *
 * Generates short, 30-character session IDs in the format:
 *   KLAUS XMD:<20-char-code>
 *
 * Flow:
 *   1. User visits site → frontend connects via WebSocket
 *   2. Server creates a new Baileys session and emits a QR code
 *   3. User scans QR with WhatsApp → Baileys connects → creds captured
 *   4. Server gzips + base64-encodes creds → full session = "KLAUS XMD:H4sI<base64>"
 *   5. Server generates a 20-char short code, stores full session in memory
 *   6. Server sends short code "KLAUS XMD:<code>" (30 chars) to the user
 *   7. User pastes into .env as SESSION_ID
 *   8. Bot calls GET /session/<code> → server returns full session
 *   9. Bot decompresses, writes creds.json, connects to WhatsApp as the same user
 */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestWaWebVersion,
} = require('gifted-baileys');

// ─── Config ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const PREFIX = 'KLAUS XMD:';
const CODE_LENGTH = 20;           // 20-char short code (so total ID is 30 chars)
const SESSION_TTL_MS = 30 * 60 * 1000;  // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000;
const TMP_DIR = path.join(__dirname, 'tmp');

// ─── In-memory session store ───────────────────────────────────────────
// code -> { fullSession: string, expiresAt: number }
const sessions = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of sessions.entries()) {
        if (entry.expiresAt < now) {
            sessions.delete(code);
            console.log(`[cleanup] expired session ${code}`);
        }
    }
}, CLEANUP_INTERVAL_MS);

// ─── Utilities ─────────────────────────────────────────────────────────
function generateShortCode() {
    // Use base64url charset (URL-safe), 20 chars from 15 random bytes
    return crypto.randomBytes(15).toString('base64url').slice(0, CODE_LENGTH);
}

async function captureSessionCreds(sessionDir) {
    /**
     * Read the multi-file auth state from disk and serialize just the creds.
     * The bot's useSQLiteAuthState() expects creds.json to be written to the session dir,
     * and it will use those creds to authenticate. (Keys are re-established by the WA protocol.)
     */
    const credsPath = path.join(sessionDir, 'creds.json');
    if (!fs.existsSync(credsPath)) {
        throw new Error('creds.json not found — session may not have completed pairing');
    }
    const credsJson = await fs.readFile(credsPath, 'utf8');
    // Validate it's parseable JSON
    JSON.parse(credsJson);

    // Gzip + base64 (naturally starts with H4sI — gzip magic bytes 1f 8b 08)
    const gzipped = zlib.gzipSync(Buffer.from(credsJson, 'utf8'));
    const b64 = gzipped.toString('base64');
    return PREFIX + b64;  // "KLAUS XMD:H4sIAAAAAAAAA..."
}

// ─── Express app ───────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

/**
 * GET /session/:code
 * Returns the full session ID (KLAUS XMD:H4sI<base64>) for the bot to fetch.
 */
app.get('/session/:code', (req, res) => {
    const code = req.params.code;
    const entry = sessions.get(code);
    if (!entry) {
        return res.status(404).type('text/plain').send('Session not found');
    }
    if (Date.now() > entry.expiresAt) {
        sessions.delete(code);
        return res.status(410).type('text/plain').send('Session expired');
    }
    // Optional: invalidate after first fetch (single-use)
    // sessions.delete(code);
    res.type('text/plain').send(entry.fullSession);
});

app.get('/health', (req, res) => {
    res.json({
        status: 'alive',
        activeSessions: sessions.size,
        uptime: process.uptime(),
    });
});

// ─── WebSocket server (for live QR / session ID updates) ──────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws) => {
    const connectionId = `pairing-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const sessionDir = path.join(TMP_DIR, connectionId);
    console.log(`[ws] new connection ${connectionId}`);

    let sock = null;
    let connectionOpen = false;

    try {
        await fs.ensureDir(sessionDir);
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version, isLatest } = await fetchLatestWaWebVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['KLAUS-XMD', 'Chrome', '1.0'],
        });

        const cleanup = async () => {
            try {
                if (sock) {
                    sock.ev.removeAllListeners();
                    sock.end && sock.end();
                }
                await fs.remove(sessionDir);
            } catch (e) {
                console.error(`[ws] cleanup error for ${connectionId}:`, e.message);
            }
        };

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    const dataUrl = await QRCode.toDataURL(qr, { width: 320 });
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ type: 'qr', qr: dataUrl }));
                    }
                } catch (e) {
                    console.error('[ws] QR generation failed:', e.message);
                }
            }

            if (connection === 'open') {
                connectionOpen = true;
                try {
                    await saveCreds();
                    const fullSession = await captureSessionCreds(sessionDir);
                    const shortCode = generateShortCode();

                    sessions.set(shortCode, {
                        fullSession,
                        expiresAt: Date.now() + SESSION_TTL_MS,
                    });

                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'session_id',
                            id: PREFIX + shortCode,           // KLAUS XMD:<20-char-code>
                            fullLength: (PREFIX + shortCode).length,
                            expiresIn: SESSION_TTL_MS,
                        }));
                    }
                    console.log(`[ws] ${connectionId} paired, code=${shortCode}`);
                } catch (e) {
                    console.error(`[ws] capture failed for ${connectionId}:`, e.message);
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Failed to capture session: ' + e.message }));
                    }
                } finally {
                    await cleanup();
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`[ws] ${connectionId} logged out`);
                    await cleanup();
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ type: 'closed', reason: 'logged_out' }));
                    }
                } else if (!connectionOpen) {
                    // Connection closed before pairing completed — allow reconnect via fresh socket
                    console.log(`[ws] ${connectionId} connection closed (code ${statusCode}) before pairing`);
                } else {
                    await cleanup();
                }
            }
        });

        ws.on('close', async () => {
            console.log(`[ws] ${connectionId} disconnected`);
            await cleanup();
        });

        ws.on('error', async (err) => {
            console.error(`[ws] ${connectionId} error:`, err.message);
            await cleanup();
        });

    } catch (e) {
        console.error('[ws] init failed:', e.message);
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to initialize: ' + e.message }));
        }
    }
});

// ─── Start ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║       𝐊𝐋𝐀𝐔𝐒-𝐗𝐌𝐃 Pairing Server v1.0.0                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`✅ HTTP server:        http://localhost:${PORT}`);
    console.log(`✅ WebSocket endpoint: ws://localhost:${PORT}/ws`);
    console.log(`✅ Session fetch:      GET /session/<code>`);
    console.log(`✅ Health check:       GET /health`);
    console.log('');
    console.log(`📦 Session ID format:  ${PREFIX}<${CODE_LENGTH}-char-code>  (${PREFIX.length + CODE_LENGTH} chars total)`);
    console.log(`⏱  Session TTL:        ${SESSION_TTL_MS / 60000} minutes`);
    console.log('');
    console.log('Waiting for connections...');
});
