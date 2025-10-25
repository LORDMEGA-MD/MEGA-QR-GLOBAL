const express = require('express');
const app = express();
const pairRouter = require('./pair'); // make sure pair.js is in the same folder

const PORT = process.env.PORT || 3000;

// Mount the pair router at root
app.use('/', pairRouter);

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
