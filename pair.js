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

function removeFile(filePath) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true });
}

// Store current socket instance globally to avoid multiple instances
let sockInstance = null;

// SSE endpoint to push QR codes
router.get('/qr-stream', async (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    const sendQR = (qr) => {
        res.write(`data: ${JSON.stringify({ qr })}\n\n`);
    };

    // If socket exists and already has QR
    if (sockInstance && sockInstance.currentQR) {
        sendQR(sockInstance.currentQR);
    }

    // Save a function to push QR to this SSE client
    sockInstance?.addQRListener(sendQR);

    // Keep connection alive
    const interval = setInterval(() => res.write(':\n\n'), 20000);

    // Clean up on client disconnect
    req.on('close', () => {
        clearInterval(interval);
        sockInstance?.removeQRListener(sendQR);
    });
});

// Main pairing route
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
            sockInstance = sock;
            sockInstance.currentQR = null;
            sockInstance.qrListeners = [];

            sockInstance.addQRListener = (fn) => sockInstance.qrListeners.push(fn);
            sockInstance.removeQRListener = (fn) => sockInstance.qrListeners = sockInstance.qrListeners.filter(f => f !== fn);
            const pushQR = (qr) => {
                sockInstance.currentQR = qr;
                sockInstance.qrListeners.forEach(f => f(qr));
            };

            sock.ev.on('connection.update', async (update) => {
                const { connection, qr, lastDisconnect } = update;

                if (qr) pushQR(qr); // send QR to all SSE clients

                if (connection === 'open') {
                    console.log('✅ WhatsApp connected');

                    // Send creds.json to the user who scanned
                    const sessionMegaMD = fs.readFileSync('./session/creds.json');

                    await sock.sendMessage(sock.user.id, {
                        document: sessionMegaMD,
                        mimetype: 'application/json',
                        fileName: 'creds.json'
                    });

                    // Custom message with context info
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

                    // Clean up session folder after sending
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
