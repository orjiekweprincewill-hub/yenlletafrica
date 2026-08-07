const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    
    // SCALE SETTINGS
    max: 100,                // Increase to 100 simultaneous "conversations"
    connectionTimeoutMillis: 10000, // If DB is too busy, fail fast (2 secs) 
    idleTimeoutMillis: 10000,      // Close unused connections faster to save RAM
    maxUses: 7500            // Refresh connections to prevent memory leaks
});

// Add an error listener so your whole site doesn't crash if the DB blips
pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool: pool // Export the pool itself for advanced features later
};
