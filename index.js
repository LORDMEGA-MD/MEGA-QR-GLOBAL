const express = require('express');
const path = require('path');
const pairRouter = require('./pair');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files (CSS, JS, HTML)
app.use(express.static(path.join(__dirname, '/')));

// Pairing API route
app.use('/pair', pairRouter);

// Serve the pairing HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'pair.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
