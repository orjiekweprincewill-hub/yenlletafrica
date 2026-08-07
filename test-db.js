const db = require('./db');

async function test() {
    try {
        const res = await db.query('SELECT NOW()');
        console.log('✅ Database is ALIVE at:', res.rows[0].now);
    } catch (err) {
        console.error('❌ Database connection failed!', err);
    }
}

test();
