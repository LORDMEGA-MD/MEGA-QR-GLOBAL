const express = require("express");
const path = require("path");
const cors = require("cors");
const app = express();

const pairRouter = require("./pair.js");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use("/api", pairRouter);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pair.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ MEGA-MD2 running on port ${PORT}`));
