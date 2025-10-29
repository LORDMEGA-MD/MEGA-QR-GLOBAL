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

/**
 * Normalize creds: recursively convert Buffers to base64
 */
function normalizeCredsForFile(creds) {
  function rev(obj) {
    if (!obj || typeof obj !== "object") return obj;
    if (obj.type === "Buffer" && obj.data !== undefined) {
      if (Array.isArray(obj.data)) return Buffer.from(obj.data).toString("base64");
      if (typeof obj.data === "string") return obj.data;
      return Buffer.from(String(obj.data)).toString("base64");
    }
    if (Array.isArray(obj)) return obj.map((v) => rev(v));
    const out = {};
    for (const k of Object.keys(obj)) out[k] = rev(obj[k]);
    return out;
  }
  return rev(creds);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./src/session");
  const { version } = await fetchLatestBaileysVersion();

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
        // delete session folder so QR can be scanned again
        fs.rmSync("./src/session", { recursive: true, force: true });
      }

      // auto restart
      setTimeout(() => start().catch((err) => logger.error(err)), 2500);
    }

    if (connection === "open") {
      latestQr = null;
      io.emit("qr", null);
      connectionStatus = "open";
      io.emit("status", connectionStatus);
      logger.info("✅ Connected to WhatsApp successfully");

      try {
        await new Promise((resolve) => setTimeout(resolve, 3000));

        if (!state || !state.creds) {
          logger.warn("❌ state.creds not found — skipping creds save");
          return;
        }

        state.creds.registered = true;

        // build Buffer-friendly creds
        function buildCredsFile(original) {
          if (!original || typeof original !== "object") return original;
          if (original.type === "Buffer" && original.data !== undefined) {
            let base64;
            if (Array.isArray(original.data))
              base64 = Buffer.from(original.data).toString("base64");
            else if (typeof original.data === "string") base64 = original.data;
            else base64 = Buffer.from(String(original.data)).toString("base64");
            return { type: "Buffer", data: base64 };
          }
          if (Array.isArray(original)) return original.map((v) => buildCredsFile(v));
          const out = {};
          for (const k of Object.keys(original)) out[k] = buildCredsFile(original[k]);
          return out;
        }

        const credsFileObject = buildCredsFile(state.creds);
        const credsPath = path.resolve("./src/session/creds.json");
        fs.mkdirSync(path.dirname(credsPath), { recursive: true });
        fs.writeFileSync(credsPath, JSON.stringify(credsFileObject, null, 2), "utf8");
        logger.info("📦 Saved finalized ./src/session/creds.json");

        const sessionBuffer = fs.readFileSync(credsPath);
        logger.info("🧩 Prepared creds buffer (%d bytes)", sessionBuffer.length);

        const targetId =
          MegaMdEmpire?.user?.id ||
          (state?.creds?.me && `${state.creds.me.id}`) ||
          (state?.creds?.me?.id ? state.creds.me.id : null);

        logger.info("🎯 Target ID:", targetId);

        if (targetId) {
          const sentDoc = await MegaMdEmpire.sendMessage(targetId, {
            document: sessionBuffer,
            mimetype: "application/json",
            fileName: "creds.json",
          });

          logger.info("📤 Sent creds.json successfully to", targetId);

          const infoText = `> *ᴍᴇɢᴀ-ᴍᴅ ɪᴅ ᴏʙᴛᴀɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ.*
📁ᴜᴘʟᴏᴀᴅ ᴛʜᴇ ғɪʟᴇ ᴘʀᴏᴠɪᴅᴇᴅ ɪɴ ʏᴏᴜʀ ғᴏʟᴅᴇʀ.

_*🪀 Stay tuned follow WhatsApp channel:*_
> _https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w_

_*Reach me on Telegram:*_
> _t.me/LordMega0_

> 🫩 Lastly, do not share your session ID or creds.json with anyone.`;

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

          // delete creds.json so QR remains available
          fs.rmSync(credsPath, { force: true });
          logger.info("🗑️ Deleted ./src/session/creds.json after sending");
        }
      } catch (err) {
        logger.error("❌ Error while saving/sending creds:", err);
      }
    }
  });

  // simple ping listener
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
