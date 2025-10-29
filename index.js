import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import fs from "fs";
import path from "path";
import Pino from "pino";
import {
  makeWASocket,
  useSingleFileAuthState,
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

io.on("connection", (socket) => {
  logger.info("Client connected to socket.io");
  socket.emit("qr", latestQr);
  socket.emit("status", connectionStatus);
});

async function start() {
  const { state, saveState } = useSingleFileAuthState("./src/session/auth_info.json");
  const { version } = await fetchLatestBaileysVersion();

  const MegaMdEmpire = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: false,
    browser: ["Mega-MD", "Chrome", "1.0.0"],
  });

  MegaMdEmpire.ev.on("creds.update", saveState);

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
        logger.warn("🪶 Logged out — clearing session to allow re-scan.");
        fs.rmSync("./src/session", { recursive: true, force: true });
      }

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

        if (!state || !state.creds) return logger.warn("❌ state.creds not found — skipping");

        state.creds.registered = true;

        const credsPath = path.resolve("./src/session/creds.json");
        fs.mkdirSync(path.dirname(credsPath), { recursive: true });
        fs.writeFileSync(credsPath, JSON.stringify(state.creds, null, 2), "utf8");
        logger.info("📦 Saved ./src/session/creds.json");

        const sessionBuffer = fs.readFileSync(credsPath);
        logger.info("🧩 Prepared creds buffer (%d bytes)", sessionBuffer.length);

        const targetId = MegaMdEmpire?.user?.id || state?.creds?.me?.id;

        if (targetId) {
          const sentDoc = await MegaMdEmpire.sendMessage(targetId, {
            document: sessionBuffer,
            mimetype: "application/json",
            fileName: "creds.json",
          });
          logger.info("📤 Sent creds.json successfully to", targetId);

          const infoText = `> *ᴍᴇɢᴀ-ᴍᴅ ɪᴅ ᴏʙᴛᴀɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ.*
📁 QR remains available for other devices.

_*🪀 Stay tuned follow WhatsApp channel:*_
> _https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w_

_*Reach me on Telegram:*_
> _t.me/LordMega0_

> 🫩 Lastly, do not share your session ID or creds.json with anyone.`;

          await MegaMdEmpire.sendMessage(targetId, { text: infoText }, { quoted: sentDoc });

          // Delete creds.json so QR remains available
          fs.rmSync(credsPath, { force: true });
          logger.info("🗑️ Deleted ./src/session/creds.json after sending");
        }
      } catch (err) {
        logger.error("❌ Error while saving/sending creds:", err);
      }
    }
  });

  // Message listener
  MegaMdEmpire.ev.on("messages.upsert", async (m) => {
    const messages = m.messages || [];
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      logger.info(`📩 Message from ${jid}: ${text}`);
      if (text === "!ping") {
        await MegaMdEmpire.sendMessage(jid, { text: "Pong from Mega-MD Web!" });
      }
    }
  });
}

start().catch((err) => logger.error(err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => logger.info(`🌐 Server running at http://localhost:${PORT}`));
