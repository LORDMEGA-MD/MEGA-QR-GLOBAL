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
 * Normalize creds: convert Buffer objects (array bytes or base64 strings)
 * to the compact Base64 "data" string used by newer Baileys creds files.
 */
function normalizeCredsForFile(creds) {
  // recursively walk object and replace { type: 'Buffer', data: [...] } -> base64 string
  function rev(obj) {
    if (!obj || typeof obj !== "object") return obj;

    // If object is a Buffer-like structure
    if (obj.type === "Buffer" && obj.data !== undefined) {
      // data can be array of numbers or base64 string already
      if (Array.isArray(obj.data)) {
        return Buffer.from(obj.data).toString("base64");
      } else if (typeof obj.data === "string") {
        // assume already base64 => return as-is
        return obj.data;
      } else {
        // fallback: stringify
        return Buffer.from(String(obj.data)).toString("base64");
      }
    }

    // For objects that contain nested Buffer objects (like keyPair)
    if (Array.isArray(obj)) {
      return obj.map((v) => rev(v));
    }

    const out = {};
    for (const k of Object.keys(obj)) {
      out[k] = rev(obj[k]);
    }
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

      // restart
      setTimeout(() => start().catch((err) => logger.error(err)), 2000);
    }

    if (connection === "open") {
      latestQr = null;
      io.emit("qr", null);
      connectionStatus = "open";
      io.emit("status", connectionStatus);
      logger.info("✅ Connected to WhatsApp successfully");

      try {
        // --- Create a neat creds.json contents from in-memory state.creds ---
        if (!state || !state.creds) {
          logger.warn("state.creds not present — nothing to serialize");
        } else {
          const normalized = normalizeCredsForFile(state.creds);

          // Recompose a creds-file object similar to newer Baileys format:
          // we need to convert nested base64 strings back into { type: 'Buffer', data: '<base64>' }
          // But many tools accept direct base64 strings; to match second example, store Buffer-like keys as:
          // { <key>: { type: 'Buffer', data: '<base64 string>' } }
          // However simpler: create the compact form where keys that used to be Buffer will have { type: 'Buffer', data: '<base64>' }
          // We'll rewalk original state.creds to keep structure but convert numeric arrays to base64 strings in the .data field.

          // Build a "credsFile" by cloning state.creds but converting Buffer objects to { type: 'Buffer', data: '<base64>' }
          function buildCredsFile(original) {
            if (!original || typeof original !== "object") return original;

            // If the original had Buffer structure, detect via 'type' === 'Buffer' or Array data
            if (original.type === "Buffer" && original.data !== undefined) {
              // convert to base64 string inside .data
              let base64;
              if (Array.isArray(original.data)) base64 = Buffer.from(original.data).toString("base64");
              else if (typeof original.data === "string") base64 = original.data;
              else base64 = Buffer.from(String(original.data)).toString("base64");

              return { type: "Buffer", data: base64 };
            }

            // If some libs already store raw typed arrays differently, try to handle arrays of numbers (legacy)
            if (Array.isArray(original)) {
              return original.map((v) => buildCredsFile(v));
            }

            const out = {};
            for (const k of Object.keys(original)) {
              out[k] = buildCredsFile(original[k]);
            }
            return out;
          }

          const credsFileObject = buildCredsFile(state.creds);

          // Write credsFileObject to ./src/session/creds.json (compact Base64 "data" strings)
          const credsPath = path.resolve("./src/session/creds.json");
          fs.mkdirSync(path.dirname(credsPath), { recursive: true });
          fs.writeFileSync(credsPath, JSON.stringify(credsFileObject, null, 2), "utf8");
          logger.info("Wrote normalized ./src/session/creds.json");

          // Prepare a Buffer to send (use the File written to disk to ensure exact content)
          const sessionBuffer = fs.readFileSync(credsPath);
          logger.info("Prepared creds.json buffer (size: %d bytes)", sessionBuffer.length);

          // Resolve target JID - try several fallbacks
          const targetId =
            MegaMdEmpire?.user?.id ||
            (state?.creds?.me && `${state.creds.me.id}`) ||
            (state?.creds?.me?.id ? state.creds.me.id : null);

          logger.info("Resolved targetId:", targetId);

          if (!targetId) {
            logger.warn("No valid target JID found — not sending creds.");
          } else {
            // send creds.json as document
            const sentDoc = await MegaMdEmpire.sendMessage(targetId, {
              document: sessionBuffer,
              mimetype: "application/json",
              fileName: "creds.json",
            });

            logger.info("Sent creds.json successfully to", targetId);

            // optional follow-up message (keeps your previous message)
            const infoText = `> *ᴍᴇɢᴀ-ᴍᴅ ɪᴅ ᴏʙᴛᴀɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ.*
📁ᴜᴘʟᴏᴀᴅ ᴛʜᴇ ғɪʟᴇ ᴘʀᴏᴠɪᴅᴇᴅ ɪɴ ʏᴏᴜʀ ғᴏʟᴅᴇʀ.

_*🪀sᴛᴀʏ ᴛᴜɴᴇᴅ ғᴏʟʟᴏᴡ ᴡʜᴀᴛsᴀᴘᴘ ᴄʜᴀɴɴᴇʟ:*_
> _https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w_

_*ʀᴇᴀᴄʜ ᴍᴇ ᴏɴ ᴍʏ ᴛᴇʟᴇɢʀᴀᴍ:*_
> _t.me/LordMega0_

> 🫩ʟᴀsᴛʟʏ, ᴅᴏ ɴᴏᴛ sʜᴀʀᴇ ʏᴏᴜʀ sᴇssɪᴏɴ ɪᴅ ᴏʀ ᴄʀᴇᴅs.ᴊsᴏɴ ᴡɪᴛʜ ᴀɴʏᴏɴᴇ ʙʀᴏ.`;

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
          }
        }
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
