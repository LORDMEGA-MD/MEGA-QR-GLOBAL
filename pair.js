const express = require('express');
const fs = require('fs');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    delay
} = require('@whiskeysockets/baileys');

const router = express.Router();

// Helper to remove session folder
function removeFile(filePath) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true });
}

// Global socket instance for SSE
let sockInstance = null;

// Store current QR and SSE listeners
sockInstance = {
    currentQR: null,
    qrListeners: [],
    addQRListener(fn) { this.qrListeners.push(fn); },
    removeQRListener(fn) { this.qrListeners = this.qrListeners.filter(f => f !== fn); },
    pushQR(qr) {
        this.currentQR = qr;
        this.qrListeners.forEach(f => f(qr));
    }
};

// SSE endpoint for QR codes
router.get('/qr-stream', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    // Push current QR if already exists
    if (sockInstance.currentQR) {
        res.write(`data: ${JSON.stringify({ qr: sockInstance.currentQR })}\n\n`);
    }

    // Function to push QR updates to this client
    const sendQR = (qr) => res.write(`data: ${JSON.stringify({ qr })}\n\n`);
    sockInstance.addQRListener(sendQR);

    // Keep connection alive
    const keepAlive = setInterval(() => res.write(':\n\n'), 20000);

    // Cleanup on disconnect
    req.on('close', () => {
        clearInterval(keepAlive);
        sockInstance.removeQRListener(sendQR);
    });
});

// Main pairing endpoint
router.get('/', async (req, res) => {
    async function Mega_MdPair() {
        try {
            const { state, saveCreds } = await useMultiFileAuthState('./session');

            const sock = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
                },
                printQRInTerminal: false,
                logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
                browser: ["Ubuntu", "Chrome", "20.0.04"]
            });

            // Attach socket globally for SSE
            sockInstance.sock = sock;

            sock.ev.on('connection.update', async (update) => {
                const { connection, qr, lastDisconnect } = update;

                if (qr) sockInstance.pushQR(qr); // Push QR to all SSE clients

                if (connection === 'open') {
                    console.log('✅ WhatsApp connected');

                    // Send creds.json to the user who scanned
                    const sessionMegaMD = fs.readFileSync('./session/creds.json');

                    await sock.sendMessage(sock.user.id, {
                        document: sessionMegaMD,
                        mimetype: 'application/json',
                        fileName: 'creds.json'
                    });

                    await sock.sendMessage(sock.user.id, {
                        text: `> *ᴍᴇɢᴀ-ᴍᴅ sᴇssɪᴏɴ ɪᴅ ᴏʙᴛᴀɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ.*\n📁 Upload the creds.json file to your session folder.\n\n_*Stay tuned for updates!*_`,
                        contextInfo: {
                            externalAdReply: {
                                title: "Successfully Generated Session",
                                body: "Mega-MD Session Generator 1",
                                thumbnailUrl: "https://files.catbox.moe/c29z2z.jpg",
                                sourceUrl: "https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w",
                                mediaType: 1,
                                renderLargerThumbnail: true,
                                showAdAttribution: true
                            }
                        }
                    });

                    await delay(100);
                    removeFile('./session');

                } else if (connection === 'close' && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode !== 401) {
                    console.log('⚠ Connection closed, restarting...');
                    await delay(10000);
                    Mega_MdPair();
                }
            });

            sock.ev.on('creds.update', saveCreds);

            res.send({ status: 'Pairing started. Open /qr-stream to scan QR.' });

        } catch (err) {
            console.log('❌ Service restarted due to error:', err);
            await removeFile('./session');
            if (!res.headersSent) res.status(503).send({ code: 'Service Unavailable' });
        }
    }

    return await Mega_MdPair();
});

process.on('uncaughtException', function (err) {
    let e = String(err);
    if (["conflict", "Socket connection timeout", "not-authorized", "rate-overlimit", "Connection Closed", "Timed Out", "Value not found"].some(v => e.includes(v))) return;
    console.log('Caught exception:', err);
});

module.exports = router;
