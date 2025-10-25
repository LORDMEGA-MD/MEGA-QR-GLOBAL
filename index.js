const express = require('express');
const app = express();
const pairRouter = require('./pair'); // pair.js in same folder
const PORT = process.env.PORT || 3000;

app.use('/', pairRouter);

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
