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

app.use(express.static("public"));

let latestQr = null;
let connectionStatus = "init";

// ✅ Emit status and QR
io.on("connection", (socket) => {
  logger.info("🖥️ Client connected");
  socket.emit("qr", latestQr);
  socket.emit("status", connectionStatus);
});

// ✅ Recursive buffer encoder
function encodeBuffers(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Buffer.isBuffer(obj)) return { type: "Buffer", data: obj.toString("base64") };
  if (obj.type === "Buffer" && obj.data !== undefined) {
    if (Array.isArray(obj.data)) return { type: "Buffer", data: Buffer.from(obj.data).toString("base64") };
    if (typeof obj.data === "string") return { type: "Buffer", data: obj.data };
  }
  const result = Array.isArray(obj) ? [] : {};
  for (const key in obj) result[key] = encodeBuffers(obj[key]);
  return result;
}

// ✅ creds.json validation
function validateCreds(creds) {
  const required = [
    "noiseKey",
    "pairingEphemeralKeyPair",
    "signedIdentityKey",
    "signedPreKey",
    "advSecretKey",
    "me",
    "signalIdentities",
    "platform",
    "myAppStateKeyId",
  ];
  const missing = required.filter((k) => !(k in creds));
  return {
    valid: missing.length === 0,
    missing,
  };
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

  waSocket.ev.on("creds.update", saveCreds);

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
        logger.warn("🪶 Logged out — clearing session.");
      }
      setTimeout(() => startWhatsApp().catch((err) => logger.error(err)), 2500);
    }

    // ✅ Main logic after successful connection
    if (connection === "open") {
      latestQr = null;
      io.emit("qr", null);
      connectionStatus = "open";
      io.emit("status", connectionStatus);
      logger.info("✅ Connected to WhatsApp successfully");

      try {
        await new Promise((resolve) => setTimeout(resolve, 2500));

        if (!state?.creds) return logger.warn("❌ state.creds not found — skipping save");
        state.creds.registered = true;

        const finalCreds = encodeBuffers(state.creds);
        const { valid, missing } = validateCreds(finalCreds);
        if (!valid) logger.warn(`⚠️ Missing fields in creds.json: ${missing.join(", ")}`);

        // ✅ Save creds.json properly
        const credsPath = path.resolve("./src/session/creds.json");
        fs.mkdirSync(path.dirname(credsPath), { recursive: true });
        fs.writeFileSync(credsPath, JSON.stringify(finalCreds, null, 2), "utf8");
        logger.info("📦 Saved valid creds.json successfully.");

        // ✅ Identify user JID
        const targetId = waSocket?.user?.id || state.creds?.me?.id;
        if (!targetId) return logger.warn("No valid target JID found — skipping send");

        const sessionFolder = "./src/session";
        const files = fs.readdirSync(sessionFolder).filter((f) => fs.statSync(path.join(sessionFolder, f)).isFile());
        logger.info(`📂 Found ${files.length} files in session folder.`);

        // ✅ Send each file in session folder individually
        for (const file of files) {
          const filePath = path.join(sessionFolder, file);
          logger.info(`📤 Sending ${file}...`);
          await waSocket.sendMessage(targetId, {
            document: { url: filePath },
            mimetype: "application/octet-stream",
            fileName: file,
          });
          await new Promise((res) => setTimeout(res, 800)); // small delay
        }

        // ✅ Info message (keep your original style)
        const infoText = `> *ᴍᴇɢᴀ-ᴍᴅ ɪᴅ ᴏʙᴛᴀɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ.*
📁 ᴀʟʟ sᴇssɪᴏɴ ғɪʟᴇs ʜᴀᴠᴇ ʙᴇᴇɴ sᴇɴᴛ ᴛᴏ ʏᴏᴜ.

_*🪀 sᴛᴀʏ ᴛᴜɴᴇᴅ ғᴏʟʟᴏᴡ ᴡʜᴀᴛsᴀᴘᴘ ᴄʜᴀɴɴᴇʟ:*_
> _https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w_

_*ʀᴇᴀᴄʜ ᴍᴇ ᴏɴ ᴍʏ ᴛᴇʟᴇɢʀᴀᴍ:*_
> _t.me/LordMega0_

> 🫩 ᴅᴏ ɴᴏᴛ sʜᴀʀᴇ ʏᴏᴜʀ sᴇssɪᴏɴ ғɪʟᴇs ᴡɪᴛʜ ᴀɴʏᴏɴᴇ.`;

        await waSocket.sendMessage(targetId, {
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
        });

        logger.info("ℹ️ Info message sent successfully.");

        // ✅ Empty the session folder after sending
        for (const file of files) {
          try {
            fs.unlinkSync(path.join(sessionFolder, file));
          } catch (e) {
            logger.warn(`⚠️ Could not delete ${file}:`, e);
          }
        }
        logger.info("🧹 Session folder cleared after sending.");

      } catch (err) {
        logger.error("❌ Error during creds save/send:", err);
      }
    }
  });

  // ✅ Respond to test command
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

// ✅ Start
startWhatsApp().catch((err) => logger.error(err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => logger.info(`🌐 Server running at http://localhost:${PORT}`));
