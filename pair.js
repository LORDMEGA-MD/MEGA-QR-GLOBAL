router.get('/', async (req, res) => {
    // Send HTTP response immediately
    res.send({ status: 'Pairing started. Open /qr-stream to scan QR.' });

    // Start pairing in background
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

            sockInstance.sock = sock;

            sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
                if (qr) sockInstance.pushQR(qr); // push QR via SSE

                if (connection === 'open') {
                    console.log('✅ WhatsApp connected');
                    const sessionMegaMD = fs.readFileSync('./session/creds.json');

                    await sock.sendMessage(sock.user.id, {
                        document: sessionMegaMD,
                        mimetype: 'application/json',
                        fileName: 'creds.json'
                    });

                    await sock.sendMessage(sock.user.id, {
                        text: '> *Session obtained successfully!* Upload the creds.json to your folder.'
                    });

                    await delay(100);
                    removeFile('./session');

                } else if (connection === 'close' && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode !== 401) {
                    console.log('⚠ Connection closed, restarting...');
                    await delay(10000);
                    Mega_MdPair(); // restart in background, do NOT send HTTP response
                }
            });

            sock.ev.on('creds.update', saveCreds);

        } catch (err) {
            console.log('❌ Service restarted due to error:', err);
            await removeFile('./session');
            // DO NOT call res.send here; request already responded
        }
    }

    Mega_MdPair(); // run async in background
});
