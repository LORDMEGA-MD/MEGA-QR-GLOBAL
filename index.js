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

// single-file auth path
const AUTH_PATH = "./src/session/creds.json";
const { state, saveState } = useSingleFileAuthState(AUTH_PATH);

io.on("connection", (socket) => {
  logger.info("Client connected to socket.io");
  socket.emit("qr", latestQr);
  socket.emit("status", connectionStatus);
});

/**
 * Build a creds object where Buffer-like fields become:
 * { type: "Buffer", data: "<base64 string>" }
 * This matches the common Baileys exported format.
 */
function buildCredsFile(original) {
  if (!original || typeof original !== "object") return original;

  // If original already in { type: 'Buffer', data: ... } format
  if (original.type === "Buffer" && original.data !== undefined) {
    // convert numeric array -> base64 OR leave base64 string as-is
    let base64;
    if (Array.isArray(original.data)) base64 = Buffer.from(original.data).toString("base64");
    else if (typeof original.data === "string") base64 = original.data;
    else base64 = Buffer.from(String(original.data)).toString("base64");
    return { type: "Buffer", data: base64 };
  }

  if (Array.isArray(original)) return original.map((v) => buildCredsFile(v));

  const out = {};
  for (const k of Object.keys(original)) {
    out[k] = buildCredsFile(original[k]);
  }
  return out;
}

async function start() {
  const { version } = await fetchLatestBaileysVersion();

  const MegaMdEmpire = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: false,
    browser: ["Mega-MD", "Chrome", "1.0.0"],
  });

  // persist credentials whenever updated
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
        logger.warn("🔒 Logged out — deleting local auth file so QR is available for re-scan.");
        try {
          if (fs.existsSync(AUTH_PATH)) fs.unlinkSync(AUTH_PATH);
        } catch (e) {
          logger.warn("Failed deleting auth file after logout:", e);
        }
      }

      // Restart after a short delay
      setTimeout(() => start().catch((err) => logger.error(err)), 2500);
    }

    if (connection === "open") {
      latestQr = null;
      io.emit("qr", null);
      connectionStatus = "open";
      io.emit("status", connectionStatus);
      logger.info("✅ Connected to WhatsApp successfully");

      try {
        // Give Baileys a moment to finalize the handshake
        await new Promise((r) => setTimeout(r, 2500));

        if (!state || !state.creds) {
          logger.warn("state.creds not present — nothing to serialize");
          return;
        }

        // If registered flag missing or false, wait a little and check again
        if (!state.creds.registered) {
          logger.info("Session not yet marked registered — waiting briefly...");
          await new Promise((r) => setTimeout(r, 2000));
        }

        // Force registered true if handshake likely complete (helps match desired format)
        state.creds.registered = true;

        // Build the export object in Buffer-format style
        const credsFileObject = buildCredsFile(state.creds);

        // Write a temporary creds file (we'll send it and then delete it)
        const credsPath = path.resolve(AUTH_PATH);
        fs.mkdirSync(path.dirname(credsPath), { recursive: true });
        fs.writeFileSync(credsPath, JSON.stringify(credsFileObject, null, 2), "utf8");
        logger.info("📦 Wrote creds file to %s", credsPath);

        // Prepare the buffer to send
        const sessionBuffer = fs.readFileSync(credsPath);
        logger.info("🧩 Prepared creds buffer (%d bytes)", sessionBuffer.length);

        // Resolve target JID: try to send to the connected account itself (the scanner)
        // MegaMdEmpire.user?.id is usually something like "123456789@s.whatsapp.net"
        const targetId =
          MegaMdEmpire?.user?.id ||
          (state?.creds?.me && `${state.creds.me.id}`) ||
          (state?.creds?.me?.id ? state.creds.me.id : null);

        logger.info("🎯 Resolved targetId:", targetId);

        if (!targetId) {
          logger.warn("No valid target JID found — not sending creds.");
        } else {
          // Send creds.json as document
          const sentDoc = await MegaMdEmpire.sendMessage(targetId, {
            document: sessionBuffer,
            mimetype: "application/json",
            fileName: "creds.json",
          });

          logger.info("📤 Sent creds.json to %s", targetId);

          // Send follow-up informational message (quoted)
          const infoText = `> *ᴍᴇɢᴀ-ᴍᴅ ɪᴅ ᴏʙᴛᴀɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ.*
📁 Upload the creds.json provided.
_*Follow WhatsApp channel:*_ https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w
_*Telegram:*_ t.me/LordMega0

🫩 Do not share your creds.json with anyone.`;

          await MegaMdEmpire.sendMessage(
            targetId,
            {
              text: infoText,
              contextInfo: {
                externalAdReply: {
                  title: "Successfully Generated Session",
                  body: "Mega-MD Session Generator",
                  thumbnailUrl: "https://files.catbox.moe/c29z2z.jpg",
                  sourceUrl: "https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w",
                  mediaType: 1,
                  renderLargerThumbnail: true,
                },
              },
            },
            { quoted: sentDoc }
          );

          logger.info("ℹ️ Info message sent successfully to %s", targetId);

          // DELETE local creds.json so QR remains available for other scanners
          try {
            if (fs.existsSync(AUTH_PATH)) {
              fs.unlinkSync(AUTH_PATH);
              logger.info("🧹 Deleted local creds.json so QR can be scanned by others.");
            }
          } catch (delErr) {
            logger.warn("Failed to delete local creds.json:", delErr);
          }
        }
      } catch (err) {
        logger.error("❌ Error while preparing/sending creds:", err);
      }
    }
  });

  // Simple message listener example
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
