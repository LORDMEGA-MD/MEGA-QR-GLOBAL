import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import Pino from 'pino';
import qrcode from 'qrcode-terminal';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';

const app = express();
const server = http.createServer(app);
const io = new IOServer(server);
const logger = Pino({ level: 'info' });

// Serve static public folder
app.use(express.static('public'));

let latestQr = null;
let connectionStatus = 'init';

io.on('connection', (socket) => {
  logger.info('Client connected to socket.io');
  // send current state
  socket.emit('qr', latestQr);
  socket.emit('status', connectionStatus);
});

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./src/session');
  const { version, isLatest } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: logger,
    printQRInTerminal: false,
    browser: ['Baileys', 'Chrome', '1.0.0']
  });

  // persist creds on update
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    // update contains fields like: connection, lastDisconnect, qr
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      // also show in terminal for debugging
      qrcode.generate(qr, { small: true });
      io.emit('qr', qr);
      connectionStatus = 'qr';
      io.emit('status', connectionStatus);
      logger.info('QR generated and emitted');
    }

    if (connection) {
      logger.info('connection update', { connection });
      connectionStatus = connection;
      io.emit('status', connectionStatus);
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      logger.info('disconnected', { reason });

      if (reason === DisconnectReason.loggedOut) {
        logger.warn('Logged out — deleting saved session. You must re-scan.');
        // optional: delete ./src/session contents here to force fresh auth
      }

      // try reconnect after short delay
      setTimeout(() => {
        start().catch(err => logger.error(err));
      }, 2000);
    }

    if (connection === 'open') {
      latestQr = null; // clear QR after successful connect
      io.emit('qr', null);
      connectionStatus = 'open';
      io.emit('status', connectionStatus);
      logger.info('Connected to WhatsApp');
    }
  });

  // basic message listener example
  sock.ev.on('messages.upsert', async (m) => {
    try {
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
    } catch (e) {
      logger.error('messages.upsert handler error', e);
    }
  });
}

start().catch(err => logger.error(err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => logger.info(`Server listening on http://localhost:${PORT}`));
