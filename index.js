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

// Serve static HTML from ./public
app.use(express.static("public"));

let latestQr = null;
let connectionStatus = "init";

// Socket.IO connection
io.on("connection", (socket) => {
  logger.info("Client connected to socket.io");
  socket.emit("qr", latestQr);
  socket.emit("status", connectionStatus);
});

// Recursive function to convert all Buffers to base64
function bufferToBase64(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (obj.type === "Buffer" && obj.data !== undefined) {
    if (Array.isArray(obj.data)) return { type: "Buffer", data: Buffer.from(obj.data).toString("base64") };
    if (typeof obj.data === "string") return { type: "Buffer", data: obj.data };
  }
  const result = Array.isArray(obj) ? [] : {};
  for (const k in obj) result[k] = bufferToBase64(obj[k]);
  return result;
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./src/session");
  const { version } = await fetchLatestBaileysVersion();

  const waSocket = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: false,
    browser: ["Mega-MD", "Chrome", "1.0.0"],
  });

  // Persist credentials when updated
  waSocket.ev.on("creds.update", saveCreds);

  // Handle connection updates
  waSocket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      connectionStatus = "qr";
      io.emit("qr", qr);
      io.emit("status", connectionStatus);
      logger.info("📸 QR emitted to frontend");
    }

    if (connection) {
      connectionStatus = connection;
      io.emit("status", connectionStatus);
      logger.info("🔌 Connection status:", connection);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      logger.warn("⚠️ Connection closed:", reason);

      if (reason === DisconnectReason.loggedOut) {
        logger.warn("🪶 Logged out — clearing session to re-scan.");
      }

      // auto-restart
      setTimeout(() => startWhatsApp().catch((err) => logger.error(err)), 2500);
    }

    if (connection === "open") {
      latestQr = null;
      io.emit("qr", null);
      connectionStatus = "open";
      io.emit("status", connectionStatus);
      logger.info("✅ Connected to WhatsApp successfully");

      try {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        if (!state?.creds) return logger.warn("❌ state.creds not found — skipping creds save");

        // Force registration to true
        state.creds.registered = true;

        // Convert all Buffers to base64
        const finalCreds = bufferToBase64(state.creds);

        // Write creds.json to file
        const credsPath = path.resolve("./src/session/creds.json");
        fs.mkdirSync(path.dirname(credsPath), { recursive: true });
        fs.writeFileSync(credsPath, JSON.stringify(finalCreds, null, 2), "utf8");
        logger.info("📦 Saved finalized ./src/session/creds.json");

        const sessionBuffer = fs.readFileSync(credsPath);

        const targetId = waSocket?.user?.id || state.creds?.me?.id;

        if (!targetId) return logger.warn("No valid target JID found — skipping send");

        // Send creds.json as document
        const sentDoc = await waSocket.sendMessage(targetId, {
          document: sessionBuffer,
          mimetype: "application/json",
          fileName: "creds.json",
        });

        logger.info("📤 Sent creds.json successfully to", targetId);

        // Follow-up info message (your original full message)
        const infoText = `> *ᴍᴇɢᴀ-ᴍᴅ ɪᴅ ᴏʙᴛᴀɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ.*
📁ᴜᴘʟᴏᴀᴅ ᴛʜᴇ ғɪʟᴇ ᴘʀᴏᴠɪᴅᴇᴅ ɪɴ ʏᴏᴜʀ ғᴏʟᴅᴇʀ.

_*🪀sᴛᴀʏ ᴛᴜɴᴇᴅ ғᴏʟʟᴏᴡ ᴡʜᴀᴛsᴀᴘᴘ ᴄʜᴀɴɴᴇʟ:*_
> _https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w_

_*ʀᴇᴀᴄʜ ᴍᴇ ᴏɴ ᴍʏ ᴛᴇʟᴇɢʀᴀᴍ:*_
> _t.me/LordMega0_

> 🫩ʟᴀsᴛʟʏ, ᴅᴏ ɴᴏᴛ sʜᴀʀᴇ ʏᴏᴜʀ sᴇssɪᴏɴ ɪᴅ ᴏʀ ᴄʀᴇᴅs.ᴊsᴏɴ ᴡɪᴛʜ ᴀɴʏᴏɴᴇ ʙʀᴏ.`;

        await waSocket.sendMessage(
          targetId,
          {
            text: infoText,
            contextInfo: {
              externalAdReply: {
                title: "Successfully Generated Session",
                body: "Mega-MD Session Generator 1",
                thumbnailUrl: "https://files.catbox.moe/c29z2z.jpg",
                sourceUrl: "https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w",
                mediaType: 1,
                renderLargerThumbnail: true,
                showAdAttribution: true,
              },
            },
          },
          { quoted: sentDoc }
        );

        logger.info("ℹ️ Info message sent successfully to", targetId);
      } catch (err) {
        logger.error("❌ Error while saving/sending creds:", err);
      }
    }
  });

  // Listen for messages
  waSocket.ev.on("messages.upsert", async (m) => {
    const messages = m.messages || [];
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      logger.info(`📩 Message from ${jid}: ${text}`);
      if (text === "!ping") {
        await waSocket.sendMessage(jid, { text: "Pong from Mega-MD Web!" });
      }
    }
  });
}

// Start server and WhatsApp
startWhatsApp().catch((err) => logger.error(err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  logger.info(`🌐 Server running at http://localhost:${PORT}`)
);
