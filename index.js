import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import Pino from 'pino';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';

const app = express();
const server = http.createServer(app);
const io = new IOServer(server);
const logger = Pino({ level: 'info' });

// Serve static files
app.use(express.static('public'));

let latestQr = null;
let connectionStatus = 'init';

io.on('connection', (socket) => {
  logger.info('Client connected to socket.io');
  socket.emit('qr', latestQr);
  socket.emit('status', connectionStatus);
});

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./src/session');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: logger,
    printQRInTerminal: false,
    browser: ['Baileys Web QR', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQr = qr;
      connectionStatus = 'qr';
      io.emit('qr', qr);         // <-- send QR to all connected browsers
      io.emit('status', connectionStatus);
      logger.info('QR emitted');
    }

    if (connection) {
      connectionStatus = connection;
      io.emit('status', connectionStatus);
      logger.info('Connection update:', { connection });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      logger.info('Disconnected', { reason });

      if (reason === DisconnectReason.loggedOut) {
        logger.warn('Logged out. You must re-scan.');
      }

      setTimeout(() => start().catch(err => logger.error(err)), 2000);
    }

    if (connection === 'open') {
      latestQr = null;
      io.emit('qr', null);
      connectionStatus = 'open';
      io.emit('status', connectionStatus);
      logger.info('Connected to WhatsApp');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const messages = m.messages || [];
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      logger.info(`Message from ${jid}: ${text}`);

      if (text === '!ping') {
        await sock.sendMessage(jid, { text: 'Pong from Baileys web QR!' });
      }
    }
  });
}

start().catch(err => logger.error(err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => logger.info(`Server running at http://localhost:${PORT}`));
