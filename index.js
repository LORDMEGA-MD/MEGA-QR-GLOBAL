import express from "express";
import { WebSocketServer } from "ws";
import { makeWASocket, useMultiFileAuthState } from "@whiskeysockets/baileys";
import pino from "pino";

const app = express();
const server = app.listen(3000, () => console.log("🌐 Open http://localhost:3000"));
const wss = new WebSocketServer({ server });

app.use(express.static("public"));

const sockets = new Set();

wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
});

const sendToAll = (data) => {
  sockets.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
  });
};

const start = async () => {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const sock = makeWASocket({
    printQRInTerminal: false, // prevent console QR
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Chrome (Linux)", "", ""],
  });

  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      console.log("📱 Sending QR to webpage...");
      sendToAll({ type: "qr", qr });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp connected!");
      sendToAll({ type: "status", status: "connected" });
    } else if (connection === "close") {
      console.log("❌ Disconnected, reconnecting...");
      start();
    }
  });

  sock.ev.on("creds.update", saveCreds);
};

start();
