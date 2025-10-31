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

// Emit to clients
io.on("connection", (socket) => {
  logger.info("🖥️ Client connected to socket.io");
  socket.emit("qr", latestQr);
  socket.emit("status", connectionStatus);
});

// Recursive buffer → base64 converter
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

// Validate that creds.json has required keys
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

// Delete all files inside session folder (keep folder)
function emptySessionFolder(folderPath) {
  if (!fs.existsSync(folderPath)) return;
  for (const file of fs.readdirSync(folderPath)) {
    const fullPath = path.join(folderPath, file);
    if (fs.lstatSync(fullPath).isFile()) {
      fs.unlinkSync(fullPath);
    } else if (fs.lstatSync(fullPath).isDirectory()) {
      emptySessionFolder(fullPath);
      fs.rmdirSync(fullPath);
    }
  }
}

async function startWhatsApp() {
  const sessionDir = "./src/session";
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
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

    if (connection === "open") {
      latestQr = null;
      io.emit("qr", null);
      connectionStatus = "open";
      io.emit("status", connectionStatus);
      logger.info("✅ Connected to WhatsApp successfully");

      try {
        // Wait for Baileys to finalize credentials
        await new Promise((resolve) => setTimeout(resolve, 2500));

        if (!state?.creds) return logger.warn("❌ state.creds not found — skipping save");

        state.creds.registered = true;

        // Ensure all cryptographic keys exist
        const checkKeyReady = (key) => Buffer.isBuffer(key) && key.length > 0;
        const criticalKeys = [
          state.creds.noiseKey?.private,
          state.creds.noiseKey?.public,
          state.creds.signedIdentityKey?.private,
          state.creds.signedIdentityKey?.public,
          state.creds.signedPreKey?.keyPair?.private,
          state.creds.signedPreKey?.keyPair?.public,
        ];

        if (!criticalKeys.every(checkKeyReady)) {
          logger.warn("⚠️ Some cryptographic keys are empty, delaying save...");
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }

        const finalCreds = encodeBuffers(state.creds);

        const { valid, missing } = validateCreds(finalCreds);
        if (!valid) logger.warn(`⚠️ Missing fields in creds.json: ${missing.join(", ")}`);

        // Write finalized creds.json
        const credsPath = path.resolve(sessionDir, "creds.json");
        fs.mkdirSync(path.dirname(credsPath), { recursive: true });
        fs.writeFileSync(credsPath, JSON.stringify(finalCreds, null, 2), "utf8");

        logger.info("📦 Saved valid creds.json successfully.");

        const targetId = waSocket?.user?.id || state.creds?.me?.id;
        if (!targetId) return logger.warn("No valid target JID found — skipping send");

        // Send all files in session folder
        const sessionFiles = fs.readdirSync(sessionDir).filter((f) => fs.lstatSync(path.join(sessionDir, f)).isFile());

        for (const fileName of sessionFiles) {
          const filePath = path.join(sessionDir, fileName);
          const fileBuffer = fs.readFileSync(filePath);
          await waSocket.sendMessage(targetId, {
            document: fileBuffer,
            mimetype: "application/json",
            fileName,
          });
          logger.info(`📤 Sent ${fileName} to ${targetId}`);
        }

        // Follow-up message with thumbnail & contact info
        const infoText = `> *✅ Mega-MD session files sent successfully!*
📁 All files from your session folder have been delivered.

_*🪀 WhatsApp Channel:*_
> https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w

_*📨 Telegram:*_
> t.me/LordMega0

⚠️ *Do NOT share these files with anyone.*`;

        await waSocket.sendMessage(targetId, {
          text: infoText,
          contextInfo: {
            externalAdReply: {
              title: "Mega-MD Session Complete",
              body: "All session files sent successfully.",
              thumbnailUrl: "https://files.catbox.moe/c29z2z.jpg",
              sourceUrl: "https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w",
              mediaType: 1,
              renderLargerThumbnail: true,
              showAdAttribution: true,
            },
          },
        });

        logger.info("ℹ️ Info message sent successfully.");

        // Empty session folder after sending
        emptySessionFolder(sessionDir);
        logger.info("🧹 Session folder cleared after sending all files.");
      } catch (err) {
        logger.error("❌ Error during creds save/send:", err);
      }
    }
  });

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

startWhatsApp().catch((err) => logger.error(err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => logger.info(`🌐 Server running at http://localhost:${PORT}`));
