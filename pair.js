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

// Socket state to handle QR streaming
let sockInstance = {
    sock: null,
    currentQR: null,
    qrListeners: [],
    isPairing: false,
    addQRListener(fn) { this.qrListeners.push(fn); },
    removeQRListener(fn) { this.qrListeners = this.qrListeners.filter(f => f !== fn); },
    pushQR(qr) {
        this.currentQR = qr;
        this.qrListeners.forEach(f => f(qr));
    }
};

// Remove a folder/file safely
function removeFile(filePath) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true });
}

// Serve QR HTML directly
router.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp Pairing</title>
<style>
body { font-family: Arial; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#f0f2f5; }
h1 { color:#333; }
#qr-container { background:white; padding:20px; border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.15); text-align:center; }
img { width:300px; height:300px; display:none; margin-top:10px; }
#status { margin-top:10px; font-weight:bold; color:#555; }
</style>
</head>
<body>
<h1>WhatsApp Pairing</h1>
<div id="qr-container">
    <div id="status">Waiting for QR...</div>
    <img id="qr-image" src="" alt="QR Code">
</div>
<script>
const statusEl = document.getElementById('status');
const qrImg = document.getElementById('qr-image');

const evtSource = new EventSource('/pair/qr-stream');

evtSource.onmessage = function(event){
    try {
        const data = JSON.parse(event.data);
        if(data.qr){
            qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(data.qr) + '&size=300x300';
            qrImg.style.display = 'block';
            statusEl.textContent = 'Scan this QR with WhatsApp';
        }
    } catch(e){ console.error(e); }
};

evtSource.onerror = function(){
    statusEl.textContent = 'Connection lost. Retrying...';
};
</script>
</body>
</html>
    `);
});

// SSE endpoint for QR updates
router.get('/qr-stream', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    res.flushHeaders();

    if (sockInstance.currentQR) {
        res.write(`data: ${JSON.stringify({ qr: sockInstance.currentQR })}\n\n`);
    }

    const sendQR = (qr) => res.write(`data: ${JSON.stringify({ qr })}\n\n`);
    sockInstance.addQRListener(sendQR);

    const keepAlive = setInterval(() => res.write(':\n\n'), 20000);

    req.on('close', () => {
        clearInterval(keepAlive);
        sockInstance.removeQRListener(sendQR);
    });
});

// Trigger pairing process
router.get('/start', (req, res) => {
    res.send({ status: 'Pairing started. Open / to scan QR.' });

    if (sockInstance.isPairing) return;
    sockInstance.isPairing = true;

    (async function Mega_MdPair() {
        try {
            const { state, saveCreds } = await useMultiFileAuthState('./session');

            const sock = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
                },
                printQRInTerminal: false,
                logger: pino({ level: 'fatal' }),
                browser: ['Ubuntu', 'Chrome', '20.0.0']
            });

            sockInstance.sock = sock;

            sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
                if (qr) sockInstance.pushQR(qr);

                if (connection === 'open') {
                    console.log('✅ WhatsApp connected');

                    const credsPath = './session/creds.json';
                    const sessionData = fs.readFileSync(credsPath);

                    await sock.sendMessage(sock.user.id, {
                        document: sessionData,
                        mimetype: 'application/json',
                        fileName: 'creds.json'
                    });

                    await sock.sendMessage(sock.user.id, {
                        text: '> Session obtained successfully! Upload creds.json to your session folder.',
                    });

                    sockInstance.currentQR = null;
                } else if (connection === 'close') {
                    const reason = lastDisconnect?.error?.output?.payload?.message || 'Unknown';
                    console.log(`⚠ Connection closed: ${reason}`);
                    if (!reason.includes('not-authorized')) {
                        await delay(10000);
                        Mega_MdPair();
                    }
                }
            });

            sock.ev.on('creds.update', saveCreds);

        } catch (err) {
            console.log('❌ Pairing failed:', err);
        } finally {
            sockInstance.isPairing = false;
        }
    })();
});

process.on('uncaughtException', function (err) {
    let e = String(err);
    if (["conflict", "Socket connection timeout", "not-authorized", "rate-overlimit", "Connection Closed", "Timed Out", "Value not found"].some(v => e.includes(v))) return;
    console.log('Caught exception:', err);
});

module.exports = router;
