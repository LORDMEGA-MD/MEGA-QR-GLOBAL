import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import Pino from 'pino';
import fs from 'fs';
import { 
  makeWASocket, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion, 
  DisconnectReason 
} from '@whiskeysockets/baileys';

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

  const MegaMdEmpire = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: false,
    browser: ['Mega-MD Web', 'Chrome', '1.0.0']
  });

  MegaMdEmpire.ev.on('creds.update', saveCreds);

  MegaMdEmpire.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQr = qr;
      connectionStatus = 'qr';
      io.emit('qr', qr);
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
      logger.warn('Disconnected', { reason });

      if (reason === DisconnectReason.loggedOut) {
        logger.warn('Logged out. Re-scan needed.');
      }

      setTimeout(() => start().catch(err => logger.error(err)), 2000);
    }

    // ✅ Once connected
    if (connection === 'open') {
      latestQr = null;
      io.emit('qr', null);
      connectionStatus = 'open';
      io.emit('status', connectionStatus);
      logger.info('Connected to WhatsApp ✅');

      try {
        // --- send creds.json to the user who scanned the QR ---
        const credsPath = './src/session/creds.json';
        if (fs.existsSync(credsPath)) {
          const sessionMegaMD = fs.readFileSync(credsPath);
          await MegaMdEmpire.sendMessage(MegaMdEmpire.user.id, {
            document: sessionMegaMD,
            mimetype: 'application/json',
            fileName: 'creds.json'
          });

          await MegaMdEmpire.sendMessage(MegaMdEmpire.user.id, {
            text: `> *ᴍᴇɢᴀ-ᴍᴅ ɪᴅ ᴏʙᴛᴀɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ.*     
📁ᴜᴘʟᴏᴀᴅ ᴛʜᴇ ғɪʟᴇ ᴘʀᴏᴠɪᴅᴇᴅ ɪɴ ʏᴏᴜʀ ғᴏʟᴅᴇʀ.

_*🪀sᴛᴀʏ ᴛᴜɴᴇᴅ ғᴏʟʟᴏᴡ ᴡʜᴀᴛsᴀᴘᴘ ᴄʜᴀɴɴᴇʟ:*_  
> _https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w_

_*ʀᴇᴀᴄʜ ᴍᴇ ᴏɴ ᴍʏ ᴛᴇʟᴇɢʀᴀᴍ:*_  
> _t.me/LordMega0_

> 🫩ʟᴀsᴛʟʏ, ᴅᴏ ɴᴏᴛ sʜᴀʀᴇ ʏᴏᴜʀ sᴇssɪᴏɴ ɪᴅ ᴏʀ ᴄʀᴇᴅs.ᴊsᴏɴ ғɪʟᴇ ᴡɪᴛʜ ᴀɴʏᴏɴᴇ.  
> ғᴏʀ ʜᴇʟᴘ: _https://wa.me/256783991705_`,
            contextInfo: {
              externalAdReply: {
                title: 'Successfully Generated Session',
                body: 'Mega-MD Session Generator 1',
                thumbnailUrl: 'https://files.catbox.moe/c29z2z.jpg',
                sourceUrl: 'https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w',
                mediaType: 1,
                renderLargerThumbnail: true,
                showAdAttribution: true
              }
            }
          });
        }

        logger.info('Session file sent successfully ✅');
      } catch (err) {
        logger.error('Error sending creds file:', err);
      }
    }
  });

  // simple ping handler
  MegaMdEmpire.ev.on('messages.upsert', async (m) => {
    const messages = m.messages || [];
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      logger.info(`Message from ${jid}: ${text}`);

      if (text === '!ping') {
        await MegaMdEmpire.sendMessage(jid, { text: 'Pong from Mega-MD Web!' });
      }
    }
  });
}

start().catch(err => logger.error(err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => logger.info(`Server running at http://localhost:${PORT}`));
