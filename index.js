import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import fs from "fs";
import path from "path";
import Pino from "pino";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";

const app = express();
const server = http.createServer(app);
const io = new IOServer(server);
const logger = Pino({ level: "info" });

// serve static HTML from ./public
app.use(express.static("public"));

let latestQr = null;
let connectionStatus = "init";

io.on("connection", (socket) => {
  logger.info("Client connected to socket.io");
  socket.emit("qr", latestQr);
  socket.emit("status", connectionStatus);
});

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./src/session");
  const { version } = await fetchLatestBaileysVersion();

  // Main socket instance
  const MegaMdEmpire = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: false,
    browser: ["Mega-MD", "Chrome", "1.0.0"],
  });

  // persist credentials when updated
  MegaMdEmpire.ev.on("creds.update", saveCreds);

  MegaMdEmpire.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      connectionStatus = "qr";
      io.emit("qr", qr);
      io.emit("status", connectionStatus);
      logger.info("QR emitted to frontend");
    }

    if (connection) {
      connectionStatus = connection;
      io.emit("status", connectionStatus);
      logger.info("Connection status:", connection);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      logger.warn("Connection closed:", reason);

      if (reason === DisconnectReason.loggedOut) {
        logger.warn("Logged out — clear session to re-scan.");
      }

      setTimeout(() => start().catch((err) => logger.error(err)), 2000);
    }

    // ✅ When connection opens successfully — send creds.json to the scanner
    if (connection === "open") {
      latestQr = null;
      io.emit("qr", null);
      connectionStatus = "open";
      io.emit("status", connectionStatus);
      logger.info("✅ Connected to WhatsApp successfully");

      try {
        const credsPath = path.resolve("./src/session/creds.json");
        logger.info("Looking for creds.json at:", credsPath);

        if (!fs.existsSync(credsPath)) {
          logger.warn("creds.json not found — cannot send session.");
          return;
        }

        const sessionBuffer = fs.readFileSync(credsPath);
        logger.info("Read creds.json (size: %d bytes)", sessionBuffer.length);

        // Try to get the user JID of the connected device
        const targetId =
          MegaMdEmpire?.user?.id ||
          (state?.creds?.me && `${state.creds.me.id}`) ||
          null;

        logger.info("Resolved targetId:", targetId);

        if (!targetId) {
          logger.warn("No valid target JID found — not sending creds.");
          return;
        }

        // --- 1️⃣ Send the creds.json document ---
        const docMsg = {
          document: sessionBuffer,
          mimetype: "application/json",
          fileName: "creds.json",
        };

        const sentDoc = await MegaMdEmpire.sendMessage(targetId, docMsg);
        logger.info("Sent creds.json successfully to", targetId);

        // --- 2️⃣ Send the follow-up info message ---
        const infoText = `> *ᴍᴇɢᴀ-ᴍᴅ ɪᴅ ᴏʙᴛᴀɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ.*     
📁ᴜᴘʟᴏᴀᴅ ᴛʜᴇ ғɪʟᴇ ᴘʀᴏᴠɪᴅᴇᴅ ɪɴ ʏᴏᴜʀ ғᴏʟᴅᴇʀ. 

_*🪀sᴛᴀʏ ᴛᴜɴᴇᴅ ғᴏʟʟᴏᴡ ᴡʜᴀᴛsᴀᴘᴘ ᴄʜᴀɴɴᴇʟ:*_ 
> _https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w_

_*ʀᴇᴀᴄʜ ᴍᴇ ᴏɴ ᴍʏ ᴛᴇʟᴇɢʀᴀᴍ:*_  
> _t.me/LordMega0_

> 🫩ʟᴀsᴛʟʏ, ᴅᴏ ɴᴏᴛ sʜᴀʀᴇ ʏᴏᴜʀ sᴇssɪᴏɴ ɪᴅ ᴏʀ ᴄʀᴇᴅs.ᴊsᴏɴ ғɪʟᴇ ᴡɪᴛʜ ᴀɴʏᴏɴᴇ ʙʀᴏ ᴀɴᴅ ғᴏʀ ᴀɴʏ ʜᴇʟᴘ _*ᴅᴍ ᴏᴡɴᴇʀ https://wa.me/256783991705*_`;

        await MegaMdEmpire.sendMessage(
          targetId,
          {
            text: infoText,
            contextInfo: {
              externalAdReply: {
                title: "Successfully Generated Session",
                body: "Mega-MD Session Generator 1",
                thumbnailUrl: "https://files.catbox.moe/c29z2z.jpg",
                sourceUrl:
                  "https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w",
                mediaType: 1,
                renderLargerThumbnail: true,
                showAdAttribution: true,
              },
            },
          },
          { quoted: sentDoc }
        );

        logger.info("Info message sent successfully to", targetId);
      } catch (err) {
        logger.error("❌ Error while sending creds:", err);
      }
    }
  });

  // Example listener for messages
  MegaMdEmpire.ev.on("messages.upsert", async (m) => {
    const messages = m.messages || [];
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const text =
        msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      logger.info(`📩 Message from ${jid}: ${text}`);

      if (text === "!ping") {
        await MegaMdEmpire.sendMessage(jid, { text: "Pong from Mega-MD Web!" });
      }
    }
  });
}

// start the app
start().catch((err) => logger.error(err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  logger.info(`🌐 Server running at http://localhost:${PORT}`)
);
