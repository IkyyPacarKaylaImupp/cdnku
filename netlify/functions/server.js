// netlify/functions/server.js
// Import handler dari server.js utama di root
const { handler } = require('../../server.js');

// Export handler agar dikenali oleh Netlify
exports.handler = handler;
