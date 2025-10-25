const express = require('express');
const pairRouter = require('./pair');

const app = express();
const PORT = process.env.PORT || 3000;

// Pairing route
app.use('/pair', pairRouter);

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT} to scan QR`);
});
