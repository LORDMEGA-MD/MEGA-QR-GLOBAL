const express = require("express");
const fs = require("fs");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");

const router = express.Router();

function removeFile(FilePath) {
  if (!fs.existsSync(FilePath)) return false;
  fs.rmSync(FilePath, { recursive: true, force: true });
}

// === MAIN ROUTE ===
router.get("/pair", async (req, res) => {
  let num = req.query.number;
  if (!num) return res.send({ code: "No number provided" });

  async function Mega_MdPair() {
    const { state, saveCreds } = await useMultiFileAuthState("./session");

    try {
      const MegaMdEmpire = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(
            state.keys,
            pino({ level: "fatal" }).child({ level: "fatal" })
          ),
        },
        logger: pino({ level: "fatal" }).child({ level: "fatal" }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
      });

      // if not registered, generate code
      if (!MegaMdEmpire.authState.creds.registered) {
        await delay(1000);
        num = num.replace(/[^0-9]/g, "");
        try {
          const code = await MegaMdEmpire.requestPairingCode(num);
          if (!res.headersSent) {
            res.send({ code });
          }
        } catch (err) {
          console.error("Error requesting code:", err);
          if (!res.headersSent) res.send({ code: "Error generating code" });
          return;
        }
      }

      MegaMdEmpire.ev.on("creds.update", saveCreds);

      MegaMdEmpire.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          console.log("✅ Connected successfully");

          await delay(10000);
          const sessionMegaMD = fs.readFileSync("./session/creds.json");

          try {
            // Auto join group
            await MegaMdEmpire.groupAcceptInvite("D7jVegPjp0lB9JPVKqHX0l");
          } catch (e) {
            console.log("Group join skipped:", e.message);
          }

          // Send creds.json to the paired number
          const MegaMds = await MegaMdEmpire.sendMessage(
            MegaMdEmpire.user.id,
            {
              document: sessionMegaMD,
              mimetype: "application/json",
              fileName: "creds.json",
            }
          );

          await MegaMdEmpire.sendMessage(
            MegaMdEmpire.user.id,
            {
              text: `> *ᴍᴇɢᴀ-ᴍᴅ sᴇssɪᴏɴ ɪᴅ ᴏʙᴛᴀɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ.*     
📁 Upload the creds.json file provided in your session folder.

🪀 Follow our WhatsApp Channel:
> _https://whatsapp.com/channel/0029Vb6covl05MUWlqZdHI2w_

💬 Telegram:
> _t.me/LordMega0_

⚠️ Do NOT share your creds.json or session ID.  
For help DM owner → _https://wa.me/256783991705_`,

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
            { quoted: MegaMds }
          );

          await delay(2000);
          removeFile("./session");
        }

        if (
          connection === "close" &&
          lastDisconnect &&
          lastDisconnect.error &&
          lastDisconnect.error.output?.statusCode != 401
        ) {
          console.log("🔁 Restarting service...");
          await delay(10000);
          Mega_MdPair();
        }
      });
    } catch (err) {
      console.log("❌ Service error:", err);
      await removeFile("./session");
      if (!res.headersSent) res.send({ code: "Service Unavailable" });
    }
  }

  return await Mega_MdPair();
});

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  const e = String(err);
  const ignore = [
    "conflict",
    "Socket connection timeout",
    "not-authorized",
    "rate-overlimit",
    "Connection Closed",
    "Timed Out",
    "Value not found",
  ];
  if (ignore.some((v) => e.includes(v))) return;
  console.log("Caught exception:", err);
});

module.exports = router;
