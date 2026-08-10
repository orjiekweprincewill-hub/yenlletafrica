require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cloudinary = require('cloudinary').v2;
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_change_this';

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// ============================================================
// 🛡️ PROCESS-LEVEL CRASH PROTECTION
// ============================================================
process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION:', err.message);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// ============================================================
// 📁 FOLDER CREATION (Local only - Vercel is read-only)
// ============================================================
if (!process.env.VERCEL) {
    const dirs = ['uploads', 'uploads/marketplace', 'uploads/courses', 'uploads/vendors', 'uploads/whatsapp', 'uploads/profiles', 'uploads/chat'];
    dirs.forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });
}

// ============================================================
// 🛡️ MIDDLEWARE
// ============================================================
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
// 🗄️ DATABASE
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.VERCEL 
    ? { rejectUnauthorized: false } 
    : { rejectUnauthorized: true }, 
  max: process.env.VERCEL ? 4 : 20, 
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
  keepAlive: !process.env.VERCEL
});

if (!process.env.VERCEL) {
  pool.query('SELECT NOW()', (err) => {
    if (err) console.error('❌ Database connection error:', err.message);
    else console.log(`✅ Connected to Neon Database successfully!`);
  });
}

// ============================================================
// 💓 DATABASE HEARTBEAT & 🧹 AUTO-DELETE (Local only)
// ============================================================
if (!process.env.VERCEL) {
    setInterval(async () => {
        try {
            await pool.query('SELECT 1');
            console.log('💓 DB Heartbeat: OK');
        } catch (err) {
            console.error('💓 DB Heartbeat Failed:', err.message);
        }
    }, 120000);

    setInterval(async () => {
        try {
            const settingsResult = await pool.query('SELECT * FROM settings WHERE id = 1');
            const settings = settingsResult.rows[0];
            if (settings) {
                const taskMinutes = settings.auto_delete_tasks_after_minutes || 1440;
                const videoMinutes = settings.auto_delete_videos_after_minutes || 1440;
                await pool.query(`DELETE FROM task_completions WHERE task_id IN (SELECT id FROM tasks WHERE created_at < NOW() - ($1 * INTERVAL '1 minute'))`, [taskMinutes]);
                await pool.query(`DELETE FROM tasks WHERE created_at < NOW() - ($1 * INTERVAL '1 minute')`, [taskMinutes]);
                await pool.query(`DELETE FROM video_completions WHERE video_id IN (SELECT id FROM videos WHERE created_at < NOW() - ($1 * INTERVAL '1 minute'))`, [videoMinutes]);
                await pool.query(`DELETE FROM videos WHERE created_at < NOW() - ($1 * INTERVAL '1 minute')`, [videoMinutes]);
                console.log(`🧹 Cleaned up expired tasks & videos (${taskMinutes}m / ${videoMinutes}m)`);
            }
        } catch (err) { console.error('Auto-delete error:', err.message); }
    }, 300000);
}

const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// ============================================================
// 💰 REWARDS STRUCTURE
// ============================================================
const REWARDS = {
    YENLITE: { WELCOME_BONUS: 267.31, DIRECT_REFERRAL: 267.31, INDIRECT_REFERRAL: 5, TASK_COMPLETION: 21.39, VIDEO_WATCH: 32.08, QUIZ_CORRECT: 5, CHAT_2MIN: 105, ARTICLE_READ: 11, WHATSAPP_SHARE: 190, MIN_ACTIVITY_WITHDRAWAL: 332.66, MIN_REFERRAL_WITHDRAWAL: 641.55, MIN_TIKTOK_WITHDRAWAL_USD: 2, MIN_TRANSFER: 1.073 },
    YENPRO: { WELCOME_BONUS: 1200.00, DIRECT_REFERRAL: 1250.00, INDIRECT_REFERRAL: 40, TASK_COMPLETION: 50, VIDEO_WATCH: 50, QUIZ_CORRECT: 11, CHAT_2MIN: 100, ARTICLE_READ: 11, WHATSAPP_SHARE: 50, MIN_ACTIVITY_WITHDRAWAL: 60000.00, MIN_REFERRAL_WITHDRAWAL: 2000, MIN_TIKTOK_WITHDRAWAL_USD: 2, MIN_TRANSFER: 3000 },
    YENVITE: { WELCOME_BONUS: 1400.00, DIRECT_REFERRAL: 1450.00, INDIRECT_REFERRAL: 40, TASK_COMPLETION: 100, VIDEO_WATCH: 100, QUIZ_CORRECT: 20, CHAT_2MIN: 200, ARTICLE_READ: 15, WHATSAPP_SHARE: 100, MIN_ACTIVITY_WITHDRAWAL: 60000.00, MIN_REFERRAL_WITHDRAWAL: 3000, MIN_TIKTOK_WITHDRAWAL_USD: 2, MIN_TRANSFER: 3000}
};
function getRewardsForPlan(plan) { return REWARDS[plan] || REWARDS.YENLITE; }

// ============================================================
// 📎 MULTER CONFIG (Memory Storage for Cloudinary)
// ============================================================
const storage = multer.memoryStorage();

function imageFilter(req, file, cb) {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.test(file.mimetype) && allowed.test(ext) ? true : new Error('Only image files allowed'));
}

const upload = multer({ storage, limits: { fileSize: 16 * 1024 * 1024 }, fileFilter: imageFilter });
const uploadWhatsapp = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: imageFilter });
const chatUpload = multer({
    storage, limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg','image/png','image/gif','image/webp','audio/webm','audio/ogg','audio/mp4','audio/mpeg'];
        cb(null, allowed.includes(file.mimetype));
    }
});

const uploadToCloudinary = (buffer, folder, resource_type = 'image') => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder, resource_type },
            (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }
        );
        uploadStream.end(buffer);
    });
};

// ============================================================
// 🛡️ RATE LIMITING & CACHE CONTROL
// ============================================================
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many login attempts' });
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/forgot-password', authLimiter);

const chatSendLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 30, message: 'Too many messages sent. Please slow down.', standardHeaders: true, legacyHeaders: false });
app.use('/api/send-message', chatSendLimiter);
app.use('/api/upload-chat-file', chatSendLimiter);
app.use('/api/start-chat-session', chatSendLimiter);
app.use('/api/complete-chat-session', chatSendLimiter);
app.use('/api/support/ticket/:ticketId/send', chatSendLimiter);
app.use('/api/vendor/ticket/:ticketId/send', chatSendLimiter);

const chatReadLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 600, message: 'Too many chat requests. Please slow down.', standardHeaders: true, legacyHeaders: false });
app.use('/api/chat-messages', chatReadLimiter);
app.use('/api/mark-messages-read', chatReadLimiter);
app.use('/api/update-online-status', chatReadLimiter);
app.use('/api/support/ticket/:ticketId/messages', chatReadLimiter);
app.use('/api/vendor/ticket/:ticketId/messages', chatReadLimiter);

const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: 'Too many requests' });
app.use('/api/', generalLimiter);

app.use((req, res, next) => {
    res.header('Service-Worker-Allowed', '/');
    if (req.path.startsWith('/api/')) {
        res.header('Cache-Control', 'no-cache, no-store, must-revalidate, private');
        res.header('Pragma', 'no-cache');
        res.header('Expires', '0');
    } else if (req.url.endsWith('service-worker.js') || req.url.endsWith('manifest.json')) {
        res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
        res.header('Cache-Control', 'public, max-age=300');
    }
    next();
});

// ============================================================
// 🔧 UTILITIES & JWT AUTH MIDDLEWARE (FIXED)
// ============================================================
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function hashPin(pin) {
    return crypto.createHash('sha256').update(pin.toString()).digest('hex');
}

function isAuthenticated(req, res, next) {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader) {
        console.error("Auth Error: No Authorization header provided");
        return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

    // Prevents "Bearer null" or "Bearer undefined" strings from passing
    if (!token || token === 'null' || token === 'undefined') {
        console.error("Auth Error: Token is missing or invalid format");
        return res.status(401).json({ error: 'Invalid token format' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // { user_id, username, role }
        next();
    } catch (err) {
        console.error("Auth Error: Token verification failed -", err.message);
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
}

const isAdmin = (req, res, next) => {
    if (req.user && (req.user.role === 'superadmin' || req.user.role === 'assistant')) {
        return next();
    }
    console.warn(`Access Denied: User role '${req.user ? req.user.role : 'Unknown'}' is not an admin.`);
    res.status(403).json({ error: 'Admin access required' });
};

async function createNotification(userId, message) {
    try {
        if (!userId) return;
        await pool.query(
            'INSERT INTO notifications (user_id, message, is_read) VALUES ($1, $2, false)',
            [userId, message]
        );
    } catch (err) {
        console.error('Notification error:', err.message);
    }
}

async function addActivityFeed(userId, action, amount = 0, description = '') {
    try {
        if (!userId) return;
        await pool.query(
            'INSERT INTO activity_feed (user_id, action, amount, description) VALUES ($1, $2, $3, $4)',
            [userId, action, amount, description]
        );
    } catch (err) {
        console.error('Activity feed error:', err.message);
    }
}

// ============================================================
// 📎 CHAT ENDPOINTS
// ============================================================
app.post('/api/upload-chat-file', isAuthenticated, chatUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        
        const isImage = req.file.mimetype.startsWith('image/');
        const resource_type = isImage ? 'image' : 'video';
        const result = await uploadToCloudinary(req.file.buffer, 'chat_files', resource_type);
        
        res.json({ success: true, file_url: result.secure_url, file_name: req.file.originalname, mimetype: req.file.mimetype });
    } catch (err) {
        console.error('Chat upload error:', err);
        res.status(500).json({ error: 'Upload failed' });
    }
});

app.post('/api/send-message', isAuthenticated, async (req, res) => {
    const { receiver_id, message, message_type, file_url, file_name, duration } = req.body;
    const sender_id = req.user.user_id; 
    if (!receiver_id) return res.status(400).json({ error: 'Receiver required' });

    const validTypes = ['text', 'image', 'voice', 'sticker'];
    const type = validTypes.includes(message_type) ? message_type : 'text';

    try {
        const result = await pool.query(
            `INSERT INTO chat_messages (sender_id, receiver_id, message, message_type, file_url, file_name, duration, read) VALUES ($1, $2, $3, $4, $5, $6, $7, false) RETURNING id, created_at`,
            [sender_id, receiver_id, message ? message.trim() : '', type, file_url || null, file_name || null, duration || null]
        );
        res.json({ success: true, message_id: result.rows[0].id, timestamp: result.rows[0].created_at });
    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.get('/api/chat-messages/:partnerId', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id; 
    const partnerId = parseInt(req.params.partnerId);
    if (isNaN(partnerId)) return res.status(400).json({ error: 'Invalid partner ID' });

    const afterId = parseInt(req.query.after) || 0;
    try {
        let query = `SELECT cm.id, cm.sender_id, cm.receiver_id, cm.message, cm.message_type, cm.file_url, cm.file_name, cm.duration, cm.read, cm.created_at, u.username as sender_username FROM chat_messages cm LEFT JOIN users u ON u.id = cm.sender_id WHERE ((cm.sender_id = $1 AND cm.receiver_id = $2) OR (cm.sender_id = $2 AND cm.receiver_id = $1))`;
        const params = [userId, partnerId];
        if (afterId > 0) { query += ` AND cm.id > $3`; params.push(afterId); }
        query += ` ORDER BY cm.created_at ASC LIMIT 100`;
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Get messages error:', err);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

app.post('/api/mark-messages-read/:partnerId', isAuthenticated, async (req, res) => {
    const partnerId = parseInt(req.params.partnerId);
    if (isNaN(partnerId)) return res.status(400).json({ error: 'Invalid partner ID' });
    try {
        await pool.query(`UPDATE chat_messages SET read = true WHERE receiver_id = $1 AND sender_id = $2`, [req.user.user_id, partnerId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Mark read error:', err);
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

app.post('/api/start-chat-session', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { partner_id } = req.body;
    if (!partner_id || isNaN(parseInt(partner_id))) return res.status(400).json({ error: 'Valid partner ID required' });

    try {
        const check = await pool.query(`SELECT id FROM chat_sessions WHERE user_id = $1 AND partner_id = $2 AND created_at = CURRENT_DATE AND reward_paid = true`, [userId, partner_id]);
        if (check.rows.length > 0) return res.json({ already_completed: true });

        await pool.query(`INSERT INTO chat_sessions (user_id, partner_id, reward_paid, created_at) VALUES ($1, $2, false, CURRENT_DATE) ON CONFLICT ON CONSTRAINT chat_sessions_user_partner_date_unique DO NOTHING`, [userId, partner_id]);
        res.json({ session_started: true, already_completed: false });
    } catch (err) {
        console.error('Start session error:', err);
        res.status(500).json({ error: 'Failed to start session' });
    }
});

app.post('/api/complete-chat-session', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { partner_id, duration } = req.body;
    if (!partner_id || isNaN(parseInt(partner_id)) || !duration || duration < 120) return res.status(400).json({ error: 'Valid partner ID required and chat must be at least 2 minutes' });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const userResult = await client.query('SELECT plan, username FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const user = userResult.rows[0];
        if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }

        const rewards = getRewardsForPlan(user.plan);
        const reward = rewards.CHAT_2MIN;

        const check = await client.query(`SELECT id FROM chat_sessions WHERE user_id = $1 AND partner_id = $2 AND created_at = CURRENT_DATE AND reward_paid = true`, [userId, partner_id]);
        if (check.rows.length > 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Already earned from this chat today' }); }

        const updateResult = await client.query(`UPDATE chat_sessions SET reward_paid = true WHERE user_id = $1 AND partner_id = $2 AND created_at = CURRENT_DATE AND reward_paid = false RETURNING id`, [userId, partner_id]);

        if (updateResult.rows.length === 0) {
            const insertResult = await client.query(`INSERT INTO chat_sessions (user_id, partner_id, reward_paid, created_at) VALUES ($1, $2, true, CURRENT_DATE) ON CONFLICT ON CONSTRAINT chat_sessions_user_partner_date_unique DO UPDATE SET reward_paid = true WHERE chat_sessions.reward_paid = false RETURNING id`, [userId, partner_id]);
            if (insertResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Already earned from this chat today' }); }
        }

        await client.query('UPDATE users SET activity_wallet = activity_wallet + $1 WHERE id = $2', [reward, userId]);
        await client.query('COMMIT');

        try {
            await addActivityFeed(userId, 'Chat Reward', reward, `Completed 2-min chat with partner #${partner_id}`);
            await createNotification(userId, `🎉 Chat complete! ¥${reward.toLocaleString()} added to Activity Wallet.`);
        } catch (notifErr) {
            console.error('Notification error (non-critical):', notifErr.message);
        }

        res.json({ success: true, reward: reward, message: 'Reward awarded successfully' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error('Complete session error:', err);
        res.status(500).json({ error: 'Failed to complete session' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/update-online-status', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { going_offline } = req.body || {};
    try {
        if (going_offline === true) {
            await pool.query(`UPDATE user_online_status SET is_online = false, last_seen = CURRENT_TIMESTAMP WHERE user_id = $1`, [userId]);
        } else {
            await pool.query(`INSERT INTO user_online_status (user_id, is_online, last_seen) VALUES ($1, true, CURRENT_TIMESTAMP) ON CONFLICT (user_id) DO UPDATE SET is_online = true, last_seen = CURRENT_TIMESTAMP`, [userId]);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Online status error:', err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

app.get('/api/all-users', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    try {
        const result = await pool.query(`SELECT u.id, u.username, u.profile_picture, u.plan, COALESCE(uos.is_online, false) as is_online, uos.last_seen FROM users u LEFT JOIN user_online_status uos ON u.id = uos.user_id WHERE u.id != $1 AND u.is_banned = false AND u.is_admin = false ORDER BY uos.is_online DESC NULLS LAST, u.username ASC`, [userId]);
        res.json(result.rows);
    } catch (err) {
        console.error('All users error:', err);
        res.status(500).json({ error: 'Failed to load users' });
    }
});

// ============================================================
// 🔐 AUTH ENDPOINTS
// ============================================================
app.post('/api/check-coupon', async (req, res) => {
    const { coupon_code } = req.body;
    if (!coupon_code) return res.status(400).json({ error: 'Coupon code required' });
    try {
        const result = await pool.query('SELECT code, plan, used FROM coupon_codes WHERE UPPER(code) = UPPER($1)', [coupon_code.trim()]);
        const coupon = result.rows[0];
        if (!coupon) return res.status(400).json({ valid: false, message: 'Coupon code not found' });
        if (coupon.used) return res.status(400).json({ valid: false, message: 'Coupon code has already been used' });
        res.json({ valid: true, message: 'Coupon code is valid', plan: coupon.plan });
    } catch (err) { console.error('Check coupon error:', err); res.status(500).json({ error: 'Failed to check coupon' }); }
});

app.post('/api/register', authLimiter, async (req, res) => {
    const { username, password, coupon_code, plan, referrer_username, country, email, phone_number } = req.body;
    if (!username || !password || !coupon_code || !plan || !country || !email || !phone_number) return res.status(400).json({ error: 'All fields required: username, password, email, phone_number, coupon_code, plan, country' });
    
    const planPrefixes = { 'YENLITE': 'LITE', 'YENPRO': 'PRO', 'YENVITE': 'VITE' };
    const selectedPlan = plan.toUpperCase();
    const prefix = planPrefixes[selectedPlan];
    if (!prefix) return res.status(400).json({ error: 'Invalid plan selected' });
    
    const cleanCoupon = coupon_code.trim().toUpperCase();
    if (!cleanCoupon.startsWith(prefix)) return res.status(400).json({ error: `Invalid coupon! ${selectedPlan} requires a coupon starting with "${prefix}"` });
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (phone_number.trim().length < 5) return res.status(400).json({ error: 'Invalid phone number' });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const couponResult = await client.query('SELECT id, used, plan FROM coupon_codes WHERE UPPER(code) = UPPER($1) FOR UPDATE', [cleanCoupon]);
        const coupon = couponResult.rows[0];
        if (!coupon || coupon.used) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Coupon code invalid or already used.' }); }
        
        const userExists = await client.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
        if (userExists.rows.length > 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Username already exists' }); }
        
        const emailExists = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
        if (emailExists.rows.length > 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Email already registered' }); }
        
        const phoneExists = await client.query('SELECT id FROM users WHERE phone_number = $1', [phone_number.trim()]);
        if (phoneExists.rows.length > 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Phone number already registered' }); }
        
        const referrerResult = await client.query('SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)', [referrer_username ? referrer_username.trim() : '']);
        const referrer = referrerResult.rows[0];
        const referrerId = (referrer && referrer_username) ? referrer.id : null;
        
        const hashedPassword = hashPassword(password);
        const newUserRewards = getRewardsForPlan(selectedPlan);
        const userResult = await client.query(
            `INSERT INTO users (username, password, email, phone_number, coupon_code, referrer_id, activity_wallet, plan, country, is_banned) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false) RETURNING id`,
            [username.trim(), hashedPassword, email.trim(), phone_number.trim(), cleanCoupon, referrerId, newUserRewards.WELCOME_BONUS, selectedPlan, country]
        );
        const userId = userResult.rows[0].id;
        
        await client.query('UPDATE coupon_codes SET used = true, used_by = $1 WHERE UPPER(code) = UPPER($2)', [userId, cleanCoupon]);
        
        await addActivityFeed(userId, 'Welcome Bonus', newUserRewards.WELCOME_BONUS, 'Registration bonus added');
        await createNotification(userId, `🎉 Welcome ${username}! You received ¥${newUserRewards.WELCOME_BONUS.toLocaleString()} bonus!`);
        
        if (referrerId) {
            const directBonus = newUserRewards.DIRECT_REFERRAL;
            await client.query(`UPDATE users SET referral_wallet = referral_wallet + $1, total_referral_earnings = total_referral_earnings + $2 WHERE id = $3`, [directBonus, directBonus, referrerId]);
            await addActivityFeed(referrerId, 'Referral Bonus', directBonus, `Bonus from ${username}'s registration`);
            await createNotification(referrerId, `💰 You earned ¥${directBonus.toLocaleString()} from ${username}'s registration!`);
            
            const indirectResult = await client.query('SELECT referrer_id FROM users WHERE id = $1', [referrerId]);
            const indirectId = indirectResult.rows[0]?.referrer_id;
            if (indirectId) {
                const indirectBonus = newUserRewards.INDIRECT_REFERRAL;
                await client.query(`UPDATE users SET referral_wallet = referral_wallet + $1, total_referral_earnings = total_referral_earnings + $2 WHERE id = $3`, [indirectBonus, indirectBonus, indirectId]);
                await addActivityFeed(indirectId, 'Indirect Referral', indirectBonus, `Bonus from ${username} (downline)`);
                await createNotification(indirectId, `💰 You earned ¥${indirectBonus.toLocaleString()} from an indirect referral!`);
            }
        }
        await client.query('COMMIT');

        const token = jwt.sign({ user_id: userId, username: username.trim(), role: 'user' }, JWT_SECRET, { expiresIn: '7d' });

        res.status(201).json({ success: true, token, message: 'Registration successful!', redirect: '/dashboard.html' });
    } catch (err) { 
        if (client) await client.query('ROLLBACK'); 
        console.error('Registration error:', err); 
        res.status(500).json({ error: 'Registration failed: ' + err.message }); 
    } finally { 
        if (client) client.release(); 
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const hashed = hashPassword(password);
    try {
        const result = await pool.query(`SELECT id, username, role, is_banned FROM users WHERE LOWER(username) = LOWER($1) AND password = $2`, [username, hashed]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Invalid username or password' });
        if (user.is_banned) return res.status(403).json({ error: 'Your account has been banned' });
        
        const token = jwt.sign(
            { user_id: user.id, username: user.username, role: user.role || 'user' },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        let redirectUrl = '/dashboard.html';
        if (user.role === 'superadmin') redirectUrl = '/admin.html';
        else if (user.role === 'assistant') redirectUrl = '/Assistance.html';
        
        res.json({ success: true, token, user_id: user.id, username: user.username, is_admin: (user.role === 'superadmin' || user.role === 'assistant'), redirect: redirectUrl });
    } catch (err) { console.error('Login error:', err); res.status(500).json({ error: 'Login failed' }); }
});

app.get('/api/check-session', isAuthenticated, (req, res) => {
    res.json({ user_id: req.user.user_id, username: req.user.username, role: req.user.role, is_admin: (req.user.role === 'superadmin' || req.user.role === 'assistant'), authenticated: true });
});

app.post('/api/logout', (req, res) => {
    res.json({ message: 'Logged out successfully' });
});

// ============================================================
// 👤 PROFILE ENDPOINTS
// ============================================================
app.get('/api/profile', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    try {
        const userResult = await pool.query(
            `SELECT username, email, phone_number, activity_wallet, referral_wallet, tiktok_wallet, bank_name, account_number, profile_picture, coupon_code, plan, country, last_spin, dark_mode, created_at, total_referral_earnings, withdrawal_pin, is_vendor
             FROM users WHERE id = $1`, [userId]
        );
        const user = userResult.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });
        const countResult = await pool.query('SELECT COUNT(*)::int as count FROM users WHERE referrer_id = $1', [userId]);
        res.json({
            user_id: userId, username: user.username, email: user.email || '', phone_number: user.phone_number || '',
            activity_wallet: parseFloat(user.activity_wallet) || 0, referral_wallet: parseFloat(user.referral_wallet) || 0,
            tiktok_wallet: parseFloat(user.tiktok_wallet) || 0, bank_name: user.bank_name || '', account_number: user.account_number || '',
            profile_picture: user.profile_picture || '', coupon_code: user.coupon_code, plan: user.plan, country: user.country,
            referral_count: countResult.rows[0].count, total_referral_earnings: parseFloat(user.total_referral_earnings) || 0,
            last_spin: user.last_spin, dark_mode: user.dark_mode || false, withdrawal_pin_set: user.withdrawal_pin !== null,
            created_at: user.created_at, is_vendor: user.is_vendor || false
        });
    } catch (err) { console.error('Profile error:', err); res.status(500).json({ error: 'Failed to load profile' }); }
});

app.post('/api/upload-profile-picture', isAuthenticated, upload.single('profile_picture'), async (req, res) => {
    const userId = req.user.user_id;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
        const result = await uploadToCloudinary(req.file.buffer, 'profile_pictures');
        const imageUrl = result.secure_url;
        
        await pool.query('UPDATE users SET profile_picture = $1 WHERE id = $2', [imageUrl, userId]);
        res.json({ message: 'Profile picture updated successfully', profile_picture: imageUrl, url: imageUrl });
    } catch (err) {
        console.error('Upload profile picture error:', err);
        res.status(500).json({ error: 'Failed to update profile picture' });
    }
});

// ============================================================
// 🏦 BANK SETUP & WITHDRAWAL PIN ENDPOINTS
// ============================================================
app.post('/api/setup-bank', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { bank_name, account_number, account_name, pin, confirm_pin } = req.body;

    if (!bank_name || !account_number || !account_name || !pin || !confirm_pin) return res.status(400).json({ error: 'All fields are required: bank_name, account_number, account_name, pin, confirm_pin' });
    const pinStr = pin.toString().trim();
    const confirmPinStr = confirm_pin.toString().trim();

    if (!/^\d{4}$/.test(pinStr)) return res.status(400).json({ error: 'PIN must be exactly 4 digits (e.g., 1234)' });
    if (pinStr !== confirmPinStr) return res.status(400).json({ error: 'PINs do not match. Please re-enter.' });
    if (bank_name.trim().length < 2) return res.status(400).json({ error: 'Bank name is too short' });

    const cleanAccountNumber = account_number.toString().replace(/\s/g, '');
    if (!/^\d{5,}$/.test(cleanAccountNumber)) return res.status(400).json({ error: 'Account number must be at least 5 digits' });
    if (account_name.trim().length < 3) return res.status(400).json({ error: 'Account name must be at least 3 characters' });

    try {
        const hashedPin = hashPin(pinStr);
        await pool.query(`UPDATE users SET bank_name = $1, account_number = $2, account_name = $3, withdrawal_pin = $4 WHERE id = $5`, [bank_name.trim(), cleanAccountNumber, account_name.trim(), hashedPin, userId]);
        await createNotification(userId, '🔐 Your bank details and withdrawal PIN have been set up successfully!');
        res.json({ success: true, message: 'Bank details and withdrawal PIN set up successfully', bank_name: bank_name.trim(), account_number: cleanAccountNumber.slice(-4).padStart(cleanAccountNumber.length, '*'), account_name: account_name.trim() });
    } catch (err) { console.error('Bank setup error:', err); res.status(500).json({ error: 'Failed to save bank details' }); }
});

app.get('/api/bank-details', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    try {
        const result = await pool.query(`SELECT bank_name, account_number, account_name, withdrawal_pin FROM users WHERE id = $1`, [userId]);
        const user = result.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ bank_name: user.bank_name || '', account_number: user.account_number || '', account_name: user.account_name || '', pin_set: user.withdrawal_pin !== null });
    } catch (err) { console.error('Bank details fetch error:', err); res.status(500).json({ error: 'Failed to load bank details' }); }
});

app.post('/api/update-bank', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { bank_name, account_number, account_name, current_pin } = req.body;
    if (!bank_name || !account_number || !account_name || !current_pin) return res.status(400).json({ error: 'All fields required: bank_name, account_number, account_name, current_pin' });

    try {
        const userResult = await pool.query('SELECT withdrawal_pin FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];
        if (!user || !user.withdrawal_pin) return res.status(400).json({ error: 'Please set up your PIN first using /api/setup-bank' });
        if (user.withdrawal_pin !== hashPin(current_pin.toString().trim())) return res.status(401).json({ error: 'Incorrect current PIN' });

        const cleanAccountNumber = account_number.toString().replace(/\s/g, '');
        await pool.query(`UPDATE users SET bank_name = $1, account_number = $2, account_name = $3 WHERE id = $4`, [bank_name.trim(), cleanAccountNumber, account_name.trim(), userId]);
        await createNotification(userId, '🏦 Your bank details have been updated successfully!');
        res.json({ success: true, message: 'Bank details updated successfully' });
    } catch (err) { console.error('Update bank error:', err); res.status(500).json({ error: 'Failed to update bank details' }); }
});

app.post('/api/change-withdrawal-pin', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { old_pin, new_pin, confirm_new_pin } = req.body;
    if (!old_pin || !new_pin || !confirm_new_pin) return res.status(400).json({ error: 'Old PIN, new PIN, and confirm new PIN are required' });

    const newPinStr = new_pin.toString().trim();
    const confirmNewPinStr = confirm_new_pin.toString().trim();
    if (!/^\d{4}$/.test(newPinStr)) return res.status(400).json({ error: 'New PIN must be exactly 4 digits' });
    if (newPinStr !== confirmNewPinStr) return res.status(400).json({ error: 'New PINs do not match' });

    try {
        const userResult = await pool.query('SELECT withdrawal_pin FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];
        if (!user || !user.withdrawal_pin) return res.status(400).json({ error: 'No PIN set. Use /api/setup-bank first.' });
        if (user.withdrawal_pin !== hashPin(old_pin.toString().trim())) return res.status(401).json({ error: 'Incorrect old PIN' });

        await pool.query('UPDATE users SET withdrawal_pin = $1 WHERE id = $2', [hashPin(newPinStr), userId]);
        await createNotification(userId, '🔐 Your withdrawal PIN has been changed successfully!');
        res.json({ success: true, message: 'Withdrawal PIN changed successfully' });
    } catch (err) { console.error('Change PIN error:', err); res.status(500).json({ error: 'Failed to change PIN' }); }
});

app.post('/api/toggle-dark-mode', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { dark_mode } = req.body;
    if (typeof dark_mode !== 'boolean') return res.status(400).json({ error: 'dark_mode must be a boolean' });
    try {
        await pool.query('UPDATE users SET dark_mode = $1 WHERE id = $2', [dark_mode, userId]);
        res.json({ message: 'Dark mode updated', dark_mode: dark_mode });
    } catch (err) { console.error('Toggle dark mode error:', err); res.status(500).json({ error: 'Failed to update dark mode' }); }
});

app.post('/api/change-password', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password) return res.status(400).json({ error: 'Old password and new password are required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    try {
        const userRes = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.password !== hashPassword(old_password)) return res.status(401).json({ error: 'Incorrect old password' });
        
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashPassword(new_password), userId]);
        createNotification(userId, '🔐 Your password was changed successfully.');
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) { console.error('Change password error:', err); res.status(500).json({ error: 'Failed to change password' }); }
});

app.post('/api/update-profile', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { bank_name, account_number } = req.body;
    try {
        if (bank_name && account_number) {
            await pool.query(`UPDATE users SET bank_name = $1, account_number = $2 WHERE id = $3`, [bank_name.trim(), account_number.trim(), userId]);
        }
        res.json({ success: true, message: 'Profile updated' });
    } catch (err) { console.error('Profile update error:', err); res.status(500).json({ error: 'Failed to update profile' }); }
});

// ============================================================
// 📋 TASKS, VIDEOS, QUIZZES, ARTICLES
// ============================================================
app.get('/api/tasks', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    try {
        const userRes = await pool.query('SELECT plan FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });
        const userRewards = getRewardsForPlan(user.plan);
        const tasksResult = await pool.query(`SELECT t.id, t.title, t.description, t.link, t.created_at FROM tasks t LEFT JOIN task_completions tc ON t.id = tc.task_id AND tc.user_id = $1 WHERE tc.id IS NULL ORDER BY t.created_at DESC LIMIT 50`, [userId]);
        res.json({ normal_tasks: tasksResult.rows.map(t => ({ ...t, reward: userRewards.TASK_COMPLETION })), total_available: tasksResult.rows.length });
    } catch (err) { console.error('Tasks fetch error:', err); res.status(500).json({ error: 'Failed to load tasks' }); }
});

app.post('/api/complete-task/:taskId', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const taskId = parseInt(req.params.taskId);
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const taskCheck = await client.query('SELECT id FROM tasks WHERE id = $1', [taskId]);
        if (taskCheck.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Task not found' }); }
        const user = (await client.query('SELECT plan, username FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
        const check = await client.query('SELECT id FROM task_completions WHERE user_id = $1 AND task_id = $2', [userId, taskId]);
        if (check.rows.length > 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Task already completed' }); }
        const reward = getRewardsForPlan(user.plan).TASK_COMPLETION;
        await client.query('UPDATE users SET activity_wallet = activity_wallet + $1 WHERE id = $2', [reward, userId]);
        await client.query('INSERT INTO task_completions (user_id, task_id) VALUES ($1, $2)', [userId, taskId]);
        await client.query('COMMIT');
        await addActivityFeed(userId, 'Task Completion', reward, `Completed task ID: ${taskId}`);
        await createNotification(userId, `✅ Task done! +¥${reward.toLocaleString()} earned.`);
        res.json({ success: true, reward });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Task completion error:', err); res.status(400).json({ error: err.message }); }
    finally { if (client) client.release(); }
});

app.get('/api/videos', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    try {
        const userRes = await pool.query('SELECT plan FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });
        const userRewards = getRewardsForPlan(user.plan);
        const videosResult = await pool.query(`SELECT v.id, v.title, v.url, v.created_at FROM videos v LEFT JOIN video_completions vc ON v.id = vc.video_id AND vc.user_id = $1 WHERE vc.id IS NULL ORDER BY v.created_at DESC LIMIT 50`, [userId]);
        res.json(videosResult.rows.map(v => ({ ...v, reward: userRewards.VIDEO_WATCH })));
    } catch (err) { console.error('Videos fetch error:', err); res.status(500).json({ error: 'Failed to load videos' }); }
});

app.post('/api/complete-video/:videoId', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const videoId = parseInt(req.params.videoId);
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const videoCheck = await client.query('SELECT id FROM videos WHERE id = $1', [videoId]);
        if (videoCheck.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Video not found' }); }
        const user = (await client.query('SELECT plan, username FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
        const check = await client.query('SELECT id FROM video_completions WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
        if (check.rows.length > 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Video already watched' }); }
        const reward = getRewardsForPlan(user.plan).VIDEO_WATCH;
        await client.query('UPDATE users SET activity_wallet = activity_wallet + $1 WHERE id = $2', [reward, userId]);
        await client.query('INSERT INTO video_completions (user_id, video_id) VALUES ($1, $2)', [userId, videoId]);
        await client.query('COMMIT');
        await addActivityFeed(userId, 'Video Watched', reward, `Watched video ID: ${videoId}`);
        await createNotification(userId, `✅ Video watched! +¥${reward.toLocaleString()} earned.`);
        res.json({ success: true, reward });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Video completion error:', err); res.status(400).json({ error: err.message }); }
    finally { if (client) client.release(); }
});

app.get('/api/quizzes', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    try {
        const result = await pool.query(`SELECT q.id, q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.created_at FROM quizzes q LEFT JOIN quiz_completions qc ON q.id = qc.quiz_id AND qc.user_id = $1 WHERE qc.id IS NULL ORDER BY q.created_at DESC LIMIT 100`, [userId]);
        res.json(result.rows);
    } catch (err) { console.error('Quizzes error:', err); res.status(500).json({ error: 'Failed to load quizzes' }); }
});

app.post('/api/submit-quiz/:quizId', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const quizId = parseInt(req.params.quizId);
    const { answer } = req.body;
    if (!quizId || !answer) return res.status(400).json({ error: 'Quiz ID and answer are required' });
    try {
        const userData = (await pool.query('SELECT plan, username FROM users WHERE id = $1', [userId])).rows[0];
        if (!userData) return res.status(404).json({ error: 'User not found' });
        const userRewards = getRewardsForPlan(userData.plan);
        const quiz = (await pool.query('SELECT correct_answer FROM quizzes WHERE id = $1', [quizId])).rows[0];
        if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
        const completionResult = await pool.query('SELECT id FROM quiz_completions WHERE user_id = $1 AND quiz_id = $2', [userId, quizId]);
        if (completionResult.rows[0]) return res.status(400).json({ error: 'Quiz already answered' });
        const isCorrect = answer.toUpperCase() === quiz.correct_answer.toUpperCase();
        const reward = isCorrect ? userRewards.QUIZ_CORRECT : 0;
        await pool.query(`INSERT INTO quiz_completions (user_id, quiz_id, user_answer, is_correct) VALUES ($1, $2, $3, $4)`, [userId, quizId, answer, isCorrect]);
        if (isCorrect) {
            await pool.query('UPDATE users SET activity_wallet = activity_wallet + $1 WHERE id = $2', [reward, userId]);
            await addActivityFeed(userId, 'Quiz Reward', reward, `Answered quiz ${quizId} correctly`);
            await createNotification(userId, `✅ Correct answer! ¥${reward.toLocaleString()} added to Activity Wallet.`);
        } else {
            await createNotification(userId, `❌ Wrong answer! Better luck next time.`);
        }
        res.json({ is_correct: isCorrect, reward: reward, correct_answer: quiz.correct_answer, message: isCorrect ? `Correct! You earned ¥${reward}` : 'Wrong answer, try next quiz!' });
    } catch (err) { console.error('Quiz submission error:', err); res.status(500).json({ error: 'Failed to submit quiz' }); }
});

app.get('/api/articles', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    try {
        const userData = (await pool.query('SELECT plan FROM users WHERE id = $1', [userId])).rows[0];
        const userRewards = getRewardsForPlan(userData.plan);
        const result = await pool.query(`SELECT a.id, a.title, a.content, a.read_time, a.created_at, CASE WHEN ac.id IS NOT NULL THEN true ELSE false END as is_read FROM articles a LEFT JOIN article_completions ac ON a.id = ac.article_id AND ac.user_id = $1 ORDER BY a.created_at DESC LIMIT 100`, [userId]);
        res.json(result.rows.map(a => ({ ...a, reward: userRewards.ARTICLE_READ })));
    } catch (err) { console.error('Articles error:', err); res.status(500).json({ error: 'Failed to load articles' }); }
});

app.get('/api/articles/:articleId', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const articleId = parseInt(req.params.articleId);
    if (!articleId) return res.status(400).json({ error: 'Invalid article ID' });
    try {
        const userData = (await pool.query('SELECT plan FROM users WHERE id = $1', [userId])).rows[0];
        const userRewards = getRewardsForPlan(userData.plan);
        const result = await pool.query(`SELECT a.id, a.title, a.content, a.read_time, a.created_at, CASE WHEN ac.id IS NOT NULL THEN true ELSE false END as is_read FROM articles a LEFT JOIN article_completions ac ON a.id = ac.article_id AND ac.user_id = $1 WHERE a.id = $2`, [userId, articleId]);
        const article = result.rows[0];
        if (!article) return res.status(404).json({ error: 'Article not found' });
        res.json({ ...article, reward: userRewards.ARTICLE_READ });
    } catch (err) { console.error('Get article error:', err); res.status(500).json({ error: 'Failed to load article' }); }
});

app.post('/api/complete-article/:articleId', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const articleId = parseInt(req.params.articleId);
    if (!articleId) return res.status(400).json({ error: 'Invalid article ID' });
    try {
        const userData = (await pool.query('SELECT plan, username FROM users WHERE id = $1', [userId])).rows[0];
        if (!userData) return res.status(404).json({ error: 'User not found' });
        const userRewards = getRewardsForPlan(userData.plan);
        const articleReward = userRewards.ARTICLE_READ;
        const completionResult = await pool.query('SELECT id FROM article_completions WHERE user_id = $1 AND article_id = $2', [userId, articleId]);
        if (completionResult.rows[0]) return res.status(400).json({ error: 'Article already read' });
        await pool.query('UPDATE users SET activity_wallet = activity_wallet + $1 WHERE id = $2', [articleReward, userId]);
        await pool.query('INSERT INTO article_completions (user_id, article_id) VALUES ($1, $2)', [userId, articleId]);
        await addActivityFeed(userId, 'Article Read', articleReward, `Read article ID: ${articleId}`);
        await createNotification(userId, `📰 Article completed! ¥${articleReward.toLocaleString()} added to Activity Wallet.`);
        res.json({ message: 'Article completed successfully', reward: articleReward });
    } catch (err) { console.error('Complete article error:', err); res.status(500).json({ error: 'Failed to complete article' }); }
});

// ============================================================
// 💰 TRANSFER ENDPOINTS
// ============================================================
app.post('/api/transfer-activity', isAuthenticated, async (req, res) => {
    const senderId = req.user.user_id;
    const { recipient_username, amount } = req.body;
    const transferAmount = parseFloat(amount);
    if (!recipient_username || !amount || transferAmount <= 0) return res.status(400).json({ error: 'Recipient username and positive amount are required' });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const senderRes = await client.query('SELECT username, plan, activity_wallet FROM users WHERE id = $1 FOR UPDATE', [senderId]);
        const sender = senderRes.rows[0];
        if (!sender) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Sender not found' }); }

        const minTransfer = getRewardsForPlan(sender.plan).MIN_TRANSFER;
        const senderBalance = parseFloat(sender.activity_wallet) || 0;

        if (transferAmount < minTransfer) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Minimum transfer is ¥${minTransfer.toLocaleString()}` }); }
        if (senderBalance < transferAmount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient activity wallet balance' }); }

        const recipientRes = await client.query('SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)', [recipient_username.trim()]);
        const recipient = recipientRes.rows[0];
        if (!recipient) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Recipient not found' }); }
        if (recipient.id === senderId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cannot transfer to yourself' }); }

        const senderUpdate = await client.query('UPDATE users SET activity_wallet = activity_wallet - $1 WHERE id = $2 RETURNING activity_wallet', [transferAmount, senderId]);
        await client.query('UPDATE users SET activity_wallet = activity_wallet + $1 WHERE id = $2', [transferAmount, recipient.id]);
        await client.query('INSERT INTO transfers (sender_id, recipient_id, amount) VALUES ($1, $2, $3)', [senderId, recipient.id, transferAmount]);

        await client.query('COMMIT');

        await addActivityFeed(senderId, 'Transfer Sent', transferAmount, `Sent ¥${transferAmount} to @${recipient.username}`);
        await addActivityFeed(recipient.id, 'Transfer Received', transferAmount, `Received ¥${transferAmount} from @${sender.username}`);
        await createNotification(recipient.id, `💰 You received ¥${transferAmount.toLocaleString()} from @${sender.username}!`);

        res.json({ success: true, message: `¥${transferAmount.toLocaleString()} transferred to @${recipient.username}`, new_balance: parseFloat(senderUpdate.rows[0].activity_wallet) });
    } catch (err) { 
        if (client) await client.query('ROLLBACK'); 
        console.error('Transfer error:', err); 
        res.status(500).json({ error: 'Transfer failed' }); 
    } finally { 
        if (client) client.release(); 
    }
});

// ============================================================
// 💸 WITHDRAWAL ENDPOINTS
// ============================================================
app.post('/api/withdraw', isAuthenticated, async (req, res) => {
    const { wallet_type, amount, pin } = req.body;
    const userId = req.user.user_id;
    if (!wallet_type || !amount || pin === undefined) return res.status(400).json({ error: 'All fields (wallet, amount, pin) are required' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const userResult = await client.query(`SELECT plan, bank_name, account_number, country, activity_wallet, referral_wallet, tiktok_wallet, username, withdrawal_pin FROM users WHERE id = $1 FOR UPDATE`, [userId]);
        const user = userResult.rows[0];
        if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
        if (!user.withdrawal_pin) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Please set your withdrawal PIN in settings first' }); }
        const hashedPin = hashPin(pin.toString());
        if (user.withdrawal_pin !== hashedPin) { await client.query('ROLLBACK'); return res.status(401).json({ error: 'Invalid withdrawal PIN' }); }
        const settingsRes = await client.query('SELECT * FROM settings WHERE id = 1');
        const settings = settingsRes.rows[0];
        if (user.country !== settings.active_country) { await client.query('ROLLBACK'); return res.status(403).json({ error: `⚠️ Withdrawals are currently CLOSED for ${user.country}. Active country: ${settings.active_country}`, active_country: settings.active_country, user_country: user.country }); }
        if (wallet_type === 'activity' && !settings.activity_withdrawal_enabled) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Activity withdrawals are currently closed.' }); }
        if (wallet_type === 'referral' && !settings.referral_withdrawal_enabled) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Referral withdrawals are currently closed.' }); }
        if (wallet_type === 'tiktok' && !settings.tiktok_withdrawal_enabled) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'TikTok withdrawals are currently closed.' }); }
        if (!user.bank_name || !user.account_number) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Update your bank details in profile first' }); }
        const userRewards = getRewardsForPlan(user.plan);
        let walletBalance = 0, minAmount = 0, walletColumn = '', currencySymbol = wallet_type === 'tiktok' ? '$' : '¥';
        if (wallet_type === 'tiktok') { walletBalance = user.tiktok_wallet || 0; minAmount = userRewards.MIN_TIKTOK_WITHDRAWAL_USD; walletColumn = 'tiktok_wallet'; }
        else if (wallet_type === 'activity') { walletBalance = user.activity_wallet || 0; minAmount = userRewards.MIN_ACTIVITY_WITHDRAWAL; walletColumn = 'activity_wallet'; }
        else if (wallet_type === 'referral') { walletBalance = user.referral_wallet || 0; minAmount = userRewards.MIN_REFERRAL_WITHDRAWAL; walletColumn = 'referral_wallet'; }
        if (amount < minAmount) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Minimum withdrawal is ${currencySymbol}${minAmount}` }); }
        if (amount > walletBalance) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Insufficient balance!` }); }
        await client.query(`UPDATE users SET ${walletColumn} = ${walletColumn} - $1 WHERE id = $2`, [amount, userId]);
        const withdrawalRes = await client.query(`INSERT INTO withdrawals (user_id, wallet_type, amount, bank_name, account_number, country, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'pending', CURRENT_TIMESTAMP) RETURNING id`, [userId, wallet_type, amount, user.bank_name, user.account_number, user.country]);
        await client.query(`INSERT INTO activity_feed (user_id, action, amount, description) VALUES ($1, $2, $3, $4)`, [userId, 'Withdrawal Requested', amount, `Requested ${wallet_type} payout to ${user.bank_name}`]);
        await client.query('COMMIT');
        const msg = `⏳ ${wallet_type.toUpperCase()} withdrawal for ${currencySymbol}${amount.toLocaleString()} submitted.`;
        await createNotification(userId, msg);
        res.json({ success: true, message: 'Withdrawal request submitted successfully', withdrawal_id: withdrawalRes.rows[0].id, country: user.country });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Withdrawal error:', err.message); res.status(500).json({ error: 'Failed to process withdrawal' }); }
    finally { if (client) client.release(); }
});

app.get('/api/user-withdrawals', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    try {
        const result = await pool.query(`SELECT id, wallet_type, amount, status, created_at FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]);
        res.json(result.rows);
    } catch (err) { console.error('User withdrawals error:', err); res.status(500).json({ error: 'Failed to load withdrawals' }); }
});

app.get('/api/withdrawal-receipt/:id', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const withdrawalId = parseInt(req.params.id);
    if (!withdrawalId) return res.status(400).json({ error: 'Invalid withdrawal ID' });
    try {
        const result = await pool.query(`SELECT w.id, w.wallet_type, w.amount, w.bank_name, w.account_number, w.status, w.created_at, u.username FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.id = $1 AND w.user_id = $2`, [withdrawalId, userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Receipt not found' });
        res.json(result.rows[0]);
    } catch (err) { console.error('Receipt fetch error:', err.message); res.status(500).json({ error: 'Failed to load receipt' }); }
});

app.get('/api/withdrawal-settings', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(`SELECT activity_withdrawal_enabled, referral_withdrawal_enabled, tiktok_withdrawal_enabled, active_country FROM settings WHERE id = 1`);
        const settings = result.rows[0] || { activity_withdrawal_enabled: false, referral_withdrawal_enabled: false, tiktok_withdrawal_enabled: false, active_country: 'NG' };
        res.json(settings);
    } catch (err) { console.error('User settings error:', err); res.status(500).json({ error: 'Failed to load settings' }); }
});

// ============================================================
// 📱 WHATSAPP, TIKTOK, SOCIAL, LEADERBOARD
// ============================================================
app.get('/api/check-whatsapp-daily-limit', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    try {
        const result = await pool.query(`SELECT COUNT(*)::int as count FROM whatsapp_posts WHERE user_id = $1 AND DATE(created_at) = CURRENT_DATE`, [userId]);
        res.json({ limit_reached: result.rows[0].count >= 1, posts_today: result.rows[0].count, max_daily_posts: 1 });
    } catch (err) { console.error('Daily limit check error:', err); res.status(500).json({ error: 'Failed to check daily limit' }); }
});

app.post('/api/create-whatsapp-post', isAuthenticated, uploadWhatsapp.single('image'), async (req, res) => {
    const userId = req.user.user_id;
    const { title, description } = req.body;
    if (!title || !description || !req.file) return res.status(400).json({ error: 'Title, description, and image are required' });
    try {
        const result = await uploadToCloudinary(req.file.buffer, 'whatsapp_posts');
        const imageUrl = result.secure_url;

        const user = (await pool.query('SELECT plan FROM users WHERE id = $1', [userId])).rows[0];
        const rewards = getRewardsForPlan(user.plan);
        const insertResult = await pool.query(`INSERT INTO whatsapp_posts (user_id, title, description, image_filename, status) VALUES ($1, $2, $3, $4, 'pending') RETURNING id`, [userId, title, description, imageUrl]);
        res.json({ success: true, message: 'Post created successfully', post_id: insertResult.rows[0].id, reward: rewards.WHATSAPP_SHARE, image_url: imageUrl });
    } catch (err) {
        console.error('Create post error:', err); res.status(500).json({ error: 'Failed to create post: ' + err.message });
    }
});

app.post('/api/mark-whatsapp-shared', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { post_id } = req.body;
    if (!post_id) return res.status(400).json({ error: 'Post ID required' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const check = await client.query(`SELECT status FROM whatsapp_posts WHERE id = $1 AND user_id = $2`, [post_id, userId]);
        if (check.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Post not found' }); }
        if (check.rows[0].status === 'earned') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Already earned from this post' }); }
        await client.query(`UPDATE whatsapp_posts SET status = 'earned' WHERE id = $1`, [post_id]);
        const userPlan = (await client.query('SELECT plan FROM users WHERE id = $1', [userId])).rows[0].plan;
        const reward = getRewardsForPlan(userPlan).WHATSAPP_SHARE;
        await client.query(`UPDATE users SET activity_wallet = activity_wallet + $1 WHERE id = $2`, [reward, userId]);
        await addActivityFeed(userId, 'WhatsApp Share', reward, `Shared post ID: ${post_id}`);
        await createNotification(userId, `🎉 Post shared! You earned ¥${reward.toLocaleString()}!`);
        await client.query('COMMIT');
        res.json({ success: true, reward: reward, message: 'Reward awarded successfully' });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Share post error:', err); res.status(500).json({ error: 'Failed to mark post as shared' }); }
    finally { if (client) client.release(); }
});

app.get('/api/my-whatsapp-posts', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, title, description, image_filename, status, created_at FROM whatsapp_posts WHERE user_id = $1 ORDER BY created_at DESC`, [req.user.user_id]);
        res.json(result.rows);
    } catch (err) { console.error('Get posts error:', err); res.status(500).json({ error: 'Failed to load posts' }); }
});

app.post('/api/generate-post-caption', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { topic, style } = req.body;
    if (!topic || !style) return res.status(400).json({ error: 'Topic and style are required' });
    try {
        const user = (await pool.query('SELECT plan FROM users WHERE id = $1', [userId])).rows[0];
        if (user.plan === 'YENLITE') return res.status(403).json({ error: 'YenAI is only available for YENPRO and YENVITE users' });
        const captions = {
            professional: [`Discover the power of ${topic}. 🚀`, `Transform your ${topic} journey.`, `Excellence in ${topic} starts here.`, `Elevate your ${topic} game.`, `Master ${topic} with expert guidance.`],
            casual: [`Hey! Just checking in about ${topic}! 👀`, `${topic} is changing the game! 🔥`, `Not to brag but... this ${topic} is 🤌`, `Your ${topic} life is about to change.`, `${topic} szn is here! 🎉`],
            funny: [`POV: You're about to make money from ${topic} 😂`, `${topic} me shocked when this works 🤑`, `They said I couldn't make money from ${topic}...`, `${topic} around and find out! 🎪`, `If ${topic} is wrong, I don't want to be right 😎`]
        };
        const list = captions[style] || captions.casual;
        res.json({ success: true, caption: list[Math.floor(Math.random() * list.length)] });
    } catch (err) { console.error('Caption generation error:', err); res.status(500).json({ error: 'Failed to generate caption' }); }
});

app.post('/api/submit-tiktok-handle', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { tiktok_handle } = req.body;
    if (!tiktok_handle || tiktok_handle.trim().length === 0) return res.status(400).json({ error: 'TikTok handle is required' });
    try {
        const cleanHandle = tiktok_handle.trim().toLowerCase().replace('@', '');
        const check = await pool.query('SELECT id FROM tiktok_submissions WHERE user_id = $1', [userId]);
        if (check.rows.length > 0) await pool.query('UPDATE tiktok_submissions SET tiktok_handle = $1 WHERE user_id = $2', [cleanHandle, userId]);
        else await pool.query('INSERT INTO tiktok_submissions (user_id, tiktok_handle) VALUES ($1, $2)', [userId, cleanHandle]);
        await createNotification(userId, `📱 TikTok handle @${cleanHandle} submitted for review!`);
        res.json({ success: true, message: 'TikTok handle submitted successfully' });
    } catch (err) { console.error('TikTok submission error:', err); res.status(500).json({ error: 'Failed to submit TikTok handle' }); }
});

app.get('/api/my-tiktok-submission', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query('SELECT tiktok_handle, created_at FROM tiktok_submissions WHERE user_id = $1', [req.user.user_id]);
        res.json(result.rows[0] || { tiktok_handle: null });
    } catch (err) { console.error('Get TikTok submission error:', err); res.status(500).json({ error: 'Failed to load TikTok submission' }); }
});

app.get('/api/social-links', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, platform, url, icon_class FROM social_links ORDER BY platform ASC');
        res.json(result.rows);
    } catch (err) { console.error('Social links error:', err.message); res.status(500).json({ error: 'Failed to load social links' }); }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`SELECT username, profile_picture, plan, COALESCE(total_referral_earnings, 0) as total_earnings, (SELECT COUNT(*) FROM users WHERE referrer_id = u.id) as referral_count FROM users u WHERE is_banned = false AND is_admin = false ORDER BY total_earnings DESC, referral_count DESC LIMIT 50`);
        res.json(result.rows);
    } catch (err) { console.error('Leaderboard error:', err.message); res.status(500).json({ error: 'Failed to load leaderboard' }); }
});

// ============================================================
// 🔔 NOTIFICATIONS & ACTIVITY
// ============================================================
app.get('/api/notifications', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, message, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.user.user_id]);
        res.json(result.rows);
    } catch (err) { console.error('Notifications error:', err); res.status(500).json({ error: 'Failed to load notifications' }); }
});

app.post('/api/notifications/:id/read', isAuthenticated, async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2', [parseInt(req.params.id), req.user.user_id]);
        res.json({ message: 'Notification marked as read' });
    } catch (err) { console.error('Mark read error:', err); res.status(500).json({ error: 'Failed to update notification' }); }
});

app.get('/api/user-activities', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(`SELECT action, amount, TO_CHAR(created_at, 'DD Mon, HH:MI AM') as formatted_date, created_at FROM activity_feed WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.user.user_id]);
        res.json(result.rows);
    } catch (err) { console.error('Activities error:', err.message); res.status(500).json({ error: 'Failed to load activities' }); }
});

app.get('/api/user-referrals', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(`SELECT username, profile_picture, plan, created_at FROM users WHERE referrer_id = $1 ORDER BY created_at DESC`, [req.user.user_id]);
        res.json(result.rows);
    } catch (err) { console.error('Referrals error:', err); res.status(500).json({ error: 'Failed to load referrals' }); }
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    try {
        const userResult = await pool.query('SELECT id, username FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
        if (userResult.rows.length === 0) return res.json({ success: true, message: 'If this email exists, a reset link has been sent.' });
        
        const user = userResult.rows[0];
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 3600000);
        await pool.query('INSERT INTO password_resets (email, token, expires_at) VALUES ($1, $2, $3)', [email.trim(), token, expiresAt]);
        
        const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/reset-password.html?token=${token}`;
        const mailOptions = {
            from: `"Yenllet Support" <${process.env.EMAIL_USER}>`,
            to: email.trim(),
            subject: 'Password Reset Request',
            html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2 style="color: #333;">Hello ${user.username},</h2><p>You requested a password reset. Click the button below to reset your password:</p><a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 16px 0;">Reset Password</a><p>Or copy this link: <a href="${resetLink}">${resetLink}</a></p><p style="color: #666; font-size: 12px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p></div>`
        };
        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: 'Password reset link sent to your email.' });
    } catch (err) { console.error('Forgot password error:', err); res.status(500).json({ error: 'Failed to process request' }); }
});

// ============================================================
// 🎫 COUPON UPGRADE
// ============================================================
app.post('/api/apply-upgrade-coupon', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { coupon_code } = req.body;
    if (!coupon_code) return res.status(400).json({ error: 'Coupon code required' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const user = (await client.query('SELECT username, plan, referrer_id FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
        if (!user) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
        const coupon = (await client.query('SELECT code, plan, used FROM coupon_codes WHERE UPPER(code) = UPPER($1) FOR UPDATE', [coupon_code.trim()])).rows[0];
        if (!coupon) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Coupon code not found' }); }
        if (coupon.used) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Coupon code has already been used' }); }
        const validUpgrades = { 'YENLITE': ['YENPRO', 'YENVITE'], 'YENPRO': ['YENVITE'], 'YENVITE': [] };
        if (!validUpgrades[user.plan] || !validUpgrades[user.plan].includes(coupon.plan)) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Invalid upgrade. You are on ${user.plan} and cannot upgrade to ${coupon.plan}` }); }
        const newRewards = getRewardsForPlan(coupon.plan);
        await client.query('UPDATE users SET plan = $1 WHERE id = $2', [coupon.plan, userId]);
        await client.query('UPDATE users SET activity_wallet = activity_wallet + $1 WHERE id = $2', [newRewards.WELCOME_BONUS, userId]);
        await client.query('UPDATE coupon_codes SET used = true, used_by = $1 WHERE code = $2', [userId, coupon_code.trim()]);
        await addActivityFeed(userId, 'Plan Upgrade', newRewards.WELCOME_BONUS, `Upgraded from ${user.plan} to ${coupon.plan}`);
        await createNotification(userId, `🎉 Plan upgraded to ${coupon.plan}! You received ¥${newRewards.WELCOME_BONUS.toLocaleString()} bonus!`);
        if (user.referrer_id) {
            const directBonus = newRewards.DIRECT_REFERRAL;
            await client.query(`UPDATE users SET referral_wallet = referral_wallet + $1, total_referral_earnings = total_referral_earnings + $2 WHERE id = $3`, [directBonus, directBonus, user.referrer_id]);
            await addActivityFeed(user.referrer_id, 'Referral Upgrade Bonus', directBonus, `Bonus from ${user.username}'s upgrade to ${coupon.plan}`);
            await createNotification(user.referrer_id, `💰 You earned ¥${directBonus.toLocaleString()} because ${user.username} upgraded to ${coupon.plan}!`);
            const indirectId = (await client.query('SELECT referrer_id FROM users WHERE id = $1', [user.referrer_id])).rows[0]?.referrer_id;
            if (indirectId) {
                const indirectBonus = newRewards.INDIRECT_REFERRAL;
                await client.query(`UPDATE users SET referral_wallet = referral_wallet + $1, total_referral_earnings = total_referral_earnings + $2 WHERE id = $3`, [indirectBonus, indirectBonus, indirectId]);
                await addActivityFeed(indirectId, 'Indirect Referral Upgrade', indirectBonus, `Bonus from downline ${user.username}'s upgrade to ${coupon.plan}`);
                await createNotification(indirectId, `💰 You earned ¥${indirectBonus.toLocaleString()} from an indirect downline upgrade!`);
            }
        }
        await client.query('COMMIT');
        res.json({ success: true, message: 'Plan upgraded successfully', new_plan: coupon.plan, welcome_bonus: newRewards.WELCOME_BONUS });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Upgrade coupon error:', err); res.status(500).json({ error: 'Failed to apply coupon' }); }
    finally { if (client) client.release(); }
});

// ============================================================
// 🎧 SUPPORT CHAT ENDPOINTS
// ============================================================
app.post('/api/support/create-ticket', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const { subject } = req.body;
    try {
        const existing = await pool.query(`SELECT id, status, vendor_id FROM support_tickets WHERE user_id = $1 AND status IN ('waiting', 'active') ORDER BY created_at DESC LIMIT 1`, [userId]);
        if (existing.rows.length > 0) return res.json({ success: true, ticket_id: existing.rows[0].id, status: existing.rows[0].status, vendor_id: existing.rows[0].vendor_id, message: 'You already have an active ticket' });
        const result = await pool.query(`INSERT INTO support_tickets (user_id, subject, status) VALUES ($1, $2, 'waiting') RETURNING id, status`, [userId, subject || 'General Support']);
        res.json({ success: true, ticket_id: result.rows[0].id, status: result.rows[0].status, message: 'Ticket created. A vendor will respond shortly.' });
    } catch (err) { console.error('Create ticket error:', err); res.status(500).json({ error: 'Failed to create ticket' }); }
});

app.get('/api/support/my-ticket', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    try {
        const result = await pool.query(`SELECT t.id, t.subject, t.status, t.created_at, t.vendor_id, u.username as vendor_name, u.profile_picture as vendor_pic FROM support_tickets t LEFT JOIN users u ON t.vendor_id = u.id WHERE t.user_id = $1 AND t.status IN ('waiting', 'active') ORDER BY t.created_at DESC LIMIT 1`, [userId]);
        if (result.rows.length === 0) return res.json({ ticket: null });
        res.json({ ticket: result.rows[0] });
    } catch (err) { console.error('My ticket error:', err); res.status(500).json({ error: 'Failed to load ticket' }); }
});

app.get('/api/support/ticket/:ticketId/messages', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const ticketId = parseInt(req.params.ticketId);
    const afterId = parseInt(req.query.after) || 0;
    if (isNaN(ticketId)) return res.status(400).json({ error: 'Invalid ticket ID' });

    try {
        const ticket = await pool.query(`SELECT id FROM support_tickets WHERE id = $1 AND user_id = $2`, [ticketId, userId]);
        if (ticket.rows.length === 0) return res.status(403).json({ error: 'Access denied' });
        
        let query = `SELECT m.id, m.sender_id, m.sender_type, m.message, m.message_type, m.file_url, m.file_name, m.is_read, m.created_at FROM support_messages m WHERE m.ticket_id = $1`;
        const params = [ticketId];
        if (afterId > 0) { query += ` AND m.id > $2`; params.push(afterId); }
        query += ` ORDER BY m.created_at ASC LIMIT 200`;
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { console.error('Ticket messages error:', err); res.status(500).json({ error: 'Failed to load messages' }); }
});

app.post('/api/support/ticket/:ticketId/send', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const ticketId = parseInt(req.params.ticketId);
    const { message, message_type, file_url, file_name } = req.body;
    if (isNaN(ticketId)) return res.status(400).json({ error: 'Invalid ticket ID' });
    if (!message && !file_url) return res.status(400).json({ error: 'Message required' });

    try {
        const ticket = await pool.query(`SELECT id, status FROM support_tickets WHERE id = $1 AND user_id = $2`, [ticketId, userId]);
        if (ticket.rows.length === 0) return res.status(403).json({ error: 'Access denied' });
        if (ticket.rows[0].status === 'closed') return res.status(400).json({ error: 'Ticket is closed' });
        
        const result = await pool.query(`INSERT INTO support_messages (ticket_id, sender_id, sender_type, message, message_type, file_url, file_name, is_read) VALUES ($1, $2, 'user', $3, $4, $5, $6, false) RETURNING id, created_at`, [ticketId, userId, (message || '').trim(), message_type || 'text', file_url || null, file_name || null]);
        await pool.query(`UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [ticketId]);
        res.json({ success: true, message_id: result.rows[0].id, timestamp: result.rows[0].created_at });
    } catch (err) { console.error('Send support message error:', err); res.status(500).json({ error: 'Failed to send message' }); }
});

app.post('/api/support/ticket/:ticketId/close', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const ticketId = parseInt(req.params.ticketId);
    try {
        const result = await pool.query(`UPDATE support_tickets SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 AND status IN ('waiting', 'active') RETURNING id`, [ticketId, userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Ticket not found or already closed' });
        res.json({ success: true, message: 'Ticket closed' });
    } catch (err) { console.error('Close ticket error:', err); res.status(500).json({ error: 'Failed to close ticket' }); }
});

app.get('/api/vendor/tickets', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    try {
        const userCheck = await pool.query('SELECT is_vendor, vendor_active FROM users WHERE id = $1', [userId]);
        const user = userCheck.rows[0];
        if (!user || !user.is_vendor || !user.vendor_active) return res.status(403).json({ error: 'Vendor access required' });
        
        const result = await pool.query(`
            SELECT t.id, t.subject, t.status, t.created_at, t.updated_at,
                u.id as user_id, u.username, u.profile_picture, u.plan,
                (SELECT message FROM support_messages WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1) as last_message,
                (SELECT created_at FROM support_messages WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
                (SELECT COUNT(*)::int FROM support_messages WHERE ticket_id = t.id AND sender_type = 'user' AND is_read = false) as unread_count
            FROM support_tickets t JOIN users u ON t.user_id = u.id
            WHERE t.status IN ('waiting', 'active') AND (t.status = 'waiting' OR t.vendor_id = $1)
            ORDER BY CASE WHEN t.vendor_id = $1 THEN 0 ELSE 1 END, t.updated_at DESC
        `, [userId]);
        res.json(result.rows);
    } catch (err) { console.error('Vendor tickets error:', err); res.status(500).json({ error: 'Failed to load tickets' }); }
});

app.post('/api/vendor/ticket/:ticketId/assign', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const ticketId = parseInt(req.params.ticketId);
    try {
        const result = await pool.query(`UPDATE support_tickets SET vendor_id = $1, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND status = 'waiting' RETURNING id, user_id`, [userId, ticketId]);
        if (result.rows.length === 0) return res.status(400).json({ error: 'Ticket not available or already taken' });
        await createNotification(result.rows[0].user_id, '🎧 A support vendor has joined your chat.');
        res.json({ success: true, message: 'Ticket assigned to you' });
    } catch (err) { console.error('Assign ticket error:', err); res.status(500).json({ error: 'Failed to assign ticket' }); }
});

app.get('/api/vendor/ticket/:ticketId/messages', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const ticketId = parseInt(req.params.ticketId);
    const afterId = parseInt(req.query.after) || 0;
    if (isNaN(ticketId)) return res.status(400).json({ error: 'Invalid ticket ID' });

    try {
        const ticket = await pool.query(`SELECT id, vendor_id, status FROM support_tickets WHERE id = $1`, [ticketId]);
        if (ticket.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
        const t = ticket.rows[0];
        if (t.vendor_id !== userId && t.status !== 'waiting') return res.status(403).json({ error: 'This ticket is handled by another vendor' });
        
        let query = `SELECT m.id, m.sender_id, m.sender_type, m.message, m.message_type, m.file_url, m.file_name, m.is_read, m.created_at FROM support_messages m WHERE m.ticket_id = $1`;
        const params = [ticketId];
        if (afterId > 0) { query += ` AND m.id > $2`; params.push(afterId); }
        query += ` ORDER BY m.created_at ASC LIMIT 200`;
        const result = await pool.query(query, params);

        await pool.query(`UPDATE support_messages SET is_read = true WHERE ticket_id = $1 AND sender_type = 'user' AND is_read = false`, [ticketId]);
        res.json(result.rows);
    } catch (err) { console.error('Vendor messages error:', err); res.status(500).json({ error: 'Failed to load messages' }); }
});

app.post('/api/vendor/ticket/:ticketId/send', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const ticketId = parseInt(req.params.ticketId);
    const { message, message_type, file_url, file_name } = req.body;
    if (isNaN(ticketId)) return res.status(400).json({ error: 'Invalid ticket ID' });
    if (!message && !file_url) return res.status(400).json({ error: 'Message required' });

    try {
        const ticket = await pool.query(`SELECT id, vendor_id, status, user_id FROM support_tickets WHERE id = $1`, [ticketId]);
        if (ticket.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
        const t = ticket.rows[0];
        if (t.status === 'closed') return res.status(400).json({ error: 'Ticket is closed' });
        if (t.vendor_id !== userId) {
            if (t.vendor_id !== null) return res.status(403).json({ error: 'Ticket belongs to another vendor' });
            await pool.query(`UPDATE support_tickets SET vendor_id = $1, status = 'active' WHERE id = $2 AND vendor_id IS NULL`, [userId, ticketId]);
        }
        const result = await pool.query(`INSERT INTO support_messages (ticket_id, sender_id, sender_type, message, message_type, file_url, file_name, is_read) VALUES ($1, $2, 'vendor', $3, $4, $5, $6, false) RETURNING id, created_at`, [ticketId, userId, (message || '').trim(), message_type || 'text', file_url || null, file_name || null]);
        await pool.query(`UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [ticketId]);
        await createNotification(t.user_id, '💬 Support replied to your message.');
        res.json({ success: true, message_id: result.rows[0].id, timestamp: result.rows[0].created_at });
    } catch (err) { console.error('Vendor send error:', err); res.status(500).json({ error: 'Failed to send message' }); }
});

app.post('/api/vendor/ticket/:ticketId/close', isAuthenticated, async (req, res) => {
    const userId = req.user.user_id;
    const ticketId = parseInt(req.params.ticketId);
    try {
        const result = await pool.query(`UPDATE support_tickets SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = $1 AND vendor_id = $2 AND status IN ('waiting', 'active') RETURNING user_id`, [ticketId, userId]);
        if (result.rows.length === 0) return res.status(403).json({ error: 'Ticket not found or not assigned to you' });
        await createNotification(result.rows[0].user_id, '✅ Your support ticket has been closed.');
        res.json({ success: true, message: 'Ticket closed' });
    } catch (err) { console.error('Vendor close error:', err); res.status(500).json({ error: 'Failed to close ticket' }); }
});

// ---- ADMIN: VENDOR MANAGEMENT ----
app.post('/api/admin/make-vendor', isAdmin, async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'User ID required' });
    try {
        const result = await pool.query(`UPDATE users SET is_vendor = true, vendor_active = true, role = 'vendor' WHERE id = $1 AND is_admin = false RETURNING username`, [user_id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found or is admin' });
        await createNotification(user_id, '🎧 You are now a support vendor! Visit the Support page to start helping users.');
        res.json({ success: true, message: `${result.rows[0].username} is now a vendor` });
    } catch (err) { console.error('Make vendor error:', err); res.status(500).json({ error: 'Failed to make vendor' }); }
});

app.post('/api/admin/remove-vendor', isAdmin, async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'User ID required' });
    try {
        const result = await pool.query(`UPDATE users SET is_vendor = false, vendor_active = false, role = 'user' WHERE id = $1 RETURNING username`, [user_id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        await createNotification(user_id, 'ℹ️ Your vendor access has been revoked.');
        res.json({ success: true, message: `${result.rows[0].username} is no longer a vendor` });
    } catch (err) { console.error('Remove vendor error:', err); res.status(500).json({ error: 'Failed to remove vendor' }); }
});

app.get('/api/admin/vendors', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT u.id, u.username, u.email, u.profile_picture, u.vendor_active, u.created_at, (SELECT COUNT(*)::int FROM support_tickets WHERE vendor_id = u.id) as total_handled, (SELECT COUNT(*)::int FROM support_tickets WHERE vendor_id = u.id AND status = 'active') as active_now FROM users u WHERE u.is_vendor = true ORDER BY u.username ASC`);
        res.json(result.rows);
    } catch (err) { console.error('List vendors error:', err); res.status(500).json({ error: 'Failed to load vendors' }); }
});

app.get('/api/admin/search-user-for-vendor', isAdmin, async (req, res) => {
    const { q } = req.query;
    if (!q || !q.trim()) return res.status(400).json({ error: 'Search query required' });
    try {
        const result = await pool.query(`SELECT id, username, email, profile_picture, is_vendor, plan FROM users WHERE LOWER(username) LIKE LOWER($1) AND is_admin = false LIMIT 10`, [`%${q.trim()}%`]);
        res.json(result.rows);
    } catch (err) { console.error('Vendor user search error:', err); res.status(500).json({ error: 'Search failed' }); }
});

app.post('/api/admin/toggle-vendor-status', isAdmin, async (req, res) => {
    const { user_id, active } = req.body;
    if (!user_id) return res.status(400).json({ error: 'User ID required' });
    try {
        await pool.query('UPDATE users SET vendor_active = $1 WHERE id = $2 AND is_vendor = true', [Boolean(active), user_id]);
        res.json({ success: true, message: `Vendor ${active ? 'activated' : 'deactivated'}` });
    } catch (err) { console.error('Toggle vendor error:', err); res.status(500).json({ error: 'Failed to toggle vendor' }); }
});

// ============================================================
// 👑 ADMIN ENDPOINTS
// ============================================================
app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const usersResult = await pool.query('SELECT COUNT(*)::int as total FROM users WHERE id >= 1 AND is_banned = false');
        const payoutResult = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE status = 'completed'");
        const tasksResult = await pool.query('SELECT COUNT(*)::int as total FROM task_completions');
        const videosResult = await pool.query('SELECT COUNT(*)::int as total FROM video_completions');
        res.json({ total_users: usersResult.rows[0].total, total_payout: parseFloat(payoutResult.rows[0].total), total_tasks: tasksResult.rows[0].total, total_videos: videosResult.rows[0].total });
    } catch (err) { console.error('Stats error:', err); res.status(500).json({ error: 'Failed to load stats' }); }
});

app.get('/api/admin/country-stats', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT UPPER(country) as country, COUNT(*)::int as count FROM users WHERE country IS NOT NULL AND is_banned = false AND is_admin = false GROUP BY UPPER(country) ORDER BY count DESC`);
        const countryData = { 'Nigeria': 0, 'Ghana': 0, 'Cameroon': 0, 'Other': 0 };
        let total = 0;
        result.rows.forEach(row => {
            const code = row.country ? row.country.trim() : '';
            if (code === 'NG') countryData['Nigeria'] = row.count;
            else if (code === 'GH') countryData['Ghana'] = row.count;
            else if (code === 'CM') countryData['Cameroon'] = row.count;
            else if (code) countryData['Other'] += row.count;
            total += row.count;
        });
        res.json({ Nigeria: countryData.Nigeria, Ghana: countryData.Ghana, Cameroon: countryData.Cameroon, Other: countryData.Other, total: total });
    } catch (err) { console.error('Country stats error:', err); res.status(500).json({ error: 'Failed to load country stats' }); }
});

app.post('/api/admin/generate-coupon', isAdmin, async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only Super Admin can generate coupons' });
    const { plan, count } = req.body;
    if (!plan || !count || count < 1) return res.status(400).json({ error: 'Plan and count are required' });
    const planPrefixes = { 'YENLITE': 'LITE', 'YENPRO': 'PRO', 'YENVITE': 'VITE' };
    const prefix = planPrefixes[plan];
    if (!prefix) return res.status(400).json({ error: 'Invalid plan' });
    try {
        const coupons = [];
        for (let i = 0; i < count; i++) {
            const randomPart = Math.random().toString(36).substring(2, 10).toUpperCase().padEnd(8, '0');
            const code = `${prefix}${randomPart}`;
            await pool.query('INSERT INTO coupon_codes (code, plan, used) VALUES ($1, $2, false)', [code, plan]);
            coupons.push(code);
        }
        res.json({ success: true, message: `${count} coupon(s) generated for ${plan}`, coupons: coupons, prefix: prefix, plan: plan });
    } catch (err) { console.error('Generate coupon error:', err); res.status(500).json({ error: 'Failed to generate coupons' }); }
});

app.get('/api/admin/get-withdrawal-settings', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT activity_withdrawal_enabled, referral_withdrawal_enabled, tiktok_withdrawal_enabled, active_country FROM settings WHERE id = 1`);
        const settings = result.rows[0] || { activity_withdrawal_enabled: false, referral_withdrawal_enabled: false, tiktok_withdrawal_enabled: false, active_country: 'NG' };
        res.json(settings);
    } catch (err) { console.error('Settings error:', err); res.status(500).json({ error: 'Failed to load settings' }); }
});

app.post('/api/admin/update-active-country', isAdmin, async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only Super Admin can change the active country' });
    const { country } = req.body;
    if (!country) return res.status(400).json({ error: 'Country code is required' });
    try {
        const s = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
        if (s && (s.activity_withdrawal_enabled || s.referral_withdrawal_enabled || s.tiktok_withdrawal_enabled)) return res.status(400).json({ error: 'Cannot change country! Please turn OFF all withdrawal switches first.' });
        await pool.query(`INSERT INTO settings (id, active_country) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET active_country = EXCLUDED.active_country`, [country.trim().toUpperCase()]);
        res.json({ message: `Active country successfully set to ${country}` });
    } catch (err) { console.error('Update country database failed:', err); res.status(500).json({ error: 'Database update failed' }); }
});

app.post('/api/admin/toggle-withdrawal', isAdmin, async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Assistant cannot change site settings' });
    const { wallet_type, enabled } = req.body;
    const columnMap = { 'activity': 'activity_withdrawal_enabled', 'referral': 'referral_withdrawal_enabled', 'tiktok': 'tiktok_withdrawal_enabled' };
    const column = columnMap[wallet_type];
    if (!column) return res.status(400).json({ error: 'Invalid wallet type' });
    const isEnabled = Boolean(enabled);
    try {
        await pool.query(`INSERT INTO settings (id, ${column}) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET ${column} = EXCLUDED.${column}`, [isEnabled]);
        res.json({ message: `${wallet_type.toUpperCase()} withdrawal ${isEnabled ? 'Enabled' : 'Disabled'}` });
    } catch (err) { console.error('Toggle error:', err); res.status(500).json({ error: 'Failed to update settings' }); }
});

app.get('/api/admin/withdrawal-requests', isAdmin, async (req, res) => {
    try {
        const activeCountry = (await pool.query('SELECT active_country FROM settings WHERE id = 1')).rows[0]?.active_country || 'NG';
        const result = await pool.query(`SELECT w.id, u.username, u.country, w.amount, w.wallet_type, w.bank_name, w.account_number, w.status, TO_CHAR(w.created_at, 'DD Mon, HH:MI AM') as request_date, CASE WHEN UPPER(u.country) = UPPER($1) THEN '✅ ACTIVE' ELSE '❌ CLOSED' END as country_status FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = 'pending' ORDER BY w.created_at DESC`, [activeCountry]);
        res.json(result.rows);
    } catch (err) { console.error('Admin Fetch Error:', err); res.status(500).json({ error: 'Failed to load withdrawal requests' }); }
});

app.post('/api/admin/approve-withdrawal/:id', isAdmin, async (req, res) => {
    try {
        const result = await pool.query("UPDATE withdrawals SET status = 'completed' WHERE id = $1 RETURNING user_id, amount, wallet_type", [req.params.id]);
        const row = result.rows[0];
        if (row) {
            const currencySymbol = row.wallet_type === 'tiktok' ? '$' : '¥';
            await createNotification(row.user_id, `✅ Your withdrawal of ${currencySymbol}${parseFloat(row.amount).toLocaleString()} has been approved and sent!`);
            await addActivityFeed(row.user_id, 'Withdrawal Approved', row.amount, 'Funds sent to your bank');
        }
        res.json({ message: 'Withdrawal marked as completed' });
    } catch (err) { console.error('Approval Error:', err); res.status(500).json({ error: 'Failed to approve' }); }
});

app.post('/api/admin/reject-withdrawal/:id', isAdmin, async (req, res) => {
    const { reason } = req.body;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const resW = await client.query("UPDATE withdrawals SET status = 'rejected' WHERE id = $1 AND status = 'pending' RETURNING user_id, amount, wallet_type", [req.params.id]);
        const w = resW.rows[0];
        if (!w) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pending withdrawal not found' }); }
        const allowedWallets = { 'activity': 'activity_wallet', 'referral': 'referral_wallet', 'tiktok': 'tiktok_wallet' };
        const walletColumn = allowedWallets[w.wallet_type];
        if (!walletColumn) throw new Error('Invalid wallet type in record');
        await client.query(`UPDATE users SET ${walletColumn} = ${walletColumn} + $1 WHERE id = $2`, [w.amount, w.user_id]);
        await client.query('COMMIT');
        const currency = w.wallet_type === 'tiktok' ? '$' : '¥';
        await createNotification(w.user_id, `❌ Withdrawal rejected: ${reason || 'Bank details mismatch'}. ${currency}${parseFloat(w.amount).toLocaleString()} refunded.`);
        await addActivityFeed(w.user_id, 'Withdrawal Refund', w.amount, `Refunded due to rejection: ${reason || 'Bank error'}`);
        res.json({ message: 'Withdrawal rejected and funds refunded' });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Rejection Error:', err.message); res.status(500).json({ error: 'Failed to process rejection and refund' }); }
    finally { if (client) client.release(); }
});

app.post('/api/admin/post-task', isAdmin, async (req, res) => {
    const { title, description, link } = req.body || {};
    if (!title?.trim() || !description?.trim() || !link?.trim()) return res.status(400).json({ error: 'Title, description, and link are required' });
    try {
        const result = await pool.query('INSERT INTO tasks (title, description, link) VALUES ($1, $2, $3) RETURNING id', [title.trim(), description.trim(), link.trim()]);
        res.status(201).json({ success: true, message: 'Task posted successfully', task_id: result.rows[0].id });
    } catch (err) { console.error('Post task error:', err); res.status(500).json({ error: 'Failed to post task' }); }
});

app.get('/api/admin/tasks', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT t.id, t.title, t.description, t.link, t.created_at, (SELECT COUNT(*)::int FROM task_completions tc WHERE tc.task_id = t.id) as completion_count FROM tasks t ORDER BY t.created_at DESC LIMIT 500`);
        res.json(result.rows);
    } catch (err) { console.error('Tasks list error:', err); res.status(500).json({ error: 'Failed to load tasks' }); }
});

app.delete('/api/admin/delete-task/:id', isAdmin, async (req, res) => {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) return res.status(400).json({ error: 'Invalid task ID' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query('DELETE FROM task_completions WHERE task_id = $1', [taskId]);
        const result = await client.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [taskId]);
        if (result.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Task not found' }); }
        await client.query('COMMIT');
        res.json({ success: true, message: 'Task and completions deleted successfully' });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Delete task error:', err); res.status(500).json({ error: 'Failed to delete task' }); }
    finally { if (client) client.release(); }
});

app.post('/api/admin/post-video', isAdmin, async (req, res) => {
    const { title, url } = req.body;
    if (!title || !url) return res.status(400).json({ error: 'Title and URL are required' });
    try {
        const result = await pool.query('INSERT INTO videos (title, url) VALUES ($1, $2) RETURNING id', [title.trim(), url.trim()]);
        res.status(201).json({ message: 'Video posted successfully', video_id: result.rows[0].id });
    } catch (err) { console.error('Post video error:', err); res.status(500).json({ error: 'Failed to post video' }); }
});

app.get('/api/admin/videos', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT v.id, v.title, v.url, v.created_at, COUNT(vc.id)::int as completion_count FROM videos v LEFT JOIN video_completions vc ON v.id = vc.video_id GROUP BY v.id ORDER BY v.created_at DESC LIMIT 500`);
        res.json(result.rows);
    } catch (err) { console.error('Videos list error:', err); res.status(500).json({ error: 'Failed to load videos' }); }
});

app.delete('/api/admin/delete-video/:id', isAdmin, async (req, res) => {
    const videoId = parseInt(req.params.id);
    if (!videoId) return res.status(400).json({ error: 'Invalid video ID' });
    try {
        await pool.query('DELETE FROM video_completions WHERE video_id = $1', [videoId]);
        const result = await pool.query('DELETE FROM videos WHERE id = $1 RETURNING id', [videoId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Video not found' });
        res.json({ message: 'Video deleted successfully' });
    } catch (err) { console.error('Delete video error:', err); res.status(500).json({ error: 'Failed to delete video' }); }
});

app.post('/api/admin/post-quiz', isAdmin, async (req, res) => {
    const { question, option_a, option_b, option_c, option_d, correct_answer } = req.body;
    if (!question || !option_a || !option_b || !option_c || !option_d || !correct_answer) return res.status(400).json({ error: 'All fields are required' });
    const validAnswer = correct_answer.toUpperCase();
    if (!['A', 'B', 'C', 'D'].includes(validAnswer)) return res.status(400).json({ error: 'Correct answer must be A, B, C, or D' });
    try {
        const result = await pool.query(`INSERT INTO quizzes (question, option_a, option_b, option_c, option_d, correct_answer) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [question.trim(), option_a.trim(), option_b.trim(), option_c.trim(), option_d.trim(), validAnswer]);
        res.status(201).json({ message: 'Quiz posted successfully', quiz_id: result.rows[0].id });
    } catch (err) { console.error('Post quiz error:', err); res.status(500).json({ error: 'Failed to post quiz' }); }
});

app.get('/api/admin/quizzes', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT q.id, q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer, q.created_at, COUNT(qc.id)::int as total_attempts, COALESCE(SUM(CASE WHEN qc.is_correct = true THEN 1 ELSE 0 END), 0)::int as correct_answers FROM quizzes q LEFT JOIN quiz_completions qc ON q.id = qc.quiz_id GROUP BY q.id ORDER BY q.created_at DESC LIMIT 500`);
        res.json(result.rows);
    } catch (err) { console.error('Quizzes list error:', err); res.status(500).json({ error: 'Failed to load quizzes' }); }
});

app.delete('/api/admin/delete-quiz/:id', isAdmin, async (req, res) => {
    const quizId = parseInt(req.params.id);
    if (!quizId) return res.status(400).json({ error: 'Invalid quiz ID' });
    try {
        await pool.query('DELETE FROM quiz_completions WHERE quiz_id = $1', [quizId]);
        const result = await pool.query('DELETE FROM quizzes WHERE id = $1 RETURNING id', [quizId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Quiz not found' });
        res.json({ message: 'Quiz deleted successfully' });
    } catch (err) { console.error('Delete quiz error:', err); res.status(500).json({ error: 'Failed to delete quiz' }); }
});

app.post('/api/admin/post-article', isAdmin, async (req, res) => {
    const { title, content, read_time } = req.body;
    if (!title || !content || !read_time) return res.status(400).json({ error: 'Title, content, and read_time are required' });
    const readTimeInt = parseInt(read_time);
    if (isNaN(readTimeInt) || readTimeInt <= 0) return res.status(400).json({ error: 'Read time must be a positive integer' });
    try {
        const result = await pool.query('INSERT INTO articles (title, content, read_time) VALUES ($1, $2, $3) RETURNING id', [title.trim(), content.trim(), readTimeInt]);
        res.status(201).json({ message: 'Article posted successfully', article_id: result.rows[0].id });
    } catch (err) { console.error('Post article error:', err); res.status(500).json({ error: 'Failed to post article' }); }
});

app.get('/api/admin/articles', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT a.id, a.title, a.read_time, a.created_at, COUNT(ac.id)::int as read_count FROM articles a LEFT JOIN article_completions ac ON a.id = ac.article_id GROUP BY a.id ORDER BY a.created_at DESC LIMIT 500`);
        res.json(result.rows);
    } catch (err) { console.error('Articles list error:', err); res.status(500).json({ error: 'Failed to load articles' }); }
});

app.delete('/api/admin/delete-article/:id', isAdmin, async (req, res) => {
    const articleId = parseInt(req.params.id);
    if (!articleId) return res.status(400).json({ error: 'Invalid article ID' });
    try {
        await pool.query('DELETE FROM article_completions WHERE article_id = $1', [articleId]);
        const result = await pool.query('DELETE FROM articles WHERE id = $1 RETURNING id', [articleId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Article not found' });
        res.json({ message: 'Article deleted successfully' });
    } catch (err) { console.error('Delete article error:', err); res.status(500).json({ error: 'Failed to delete article' }); }
});

app.get('/api/admin/search-user-by-coupon', isAdmin, async (req, res) => {
    const { coupon } = req.query;
    if (!coupon) return res.status(400).json({ error: 'Coupon code required' });
    try {
        const couponData = (await pool.query('SELECT id, used, plan, used_by FROM coupon_codes WHERE UPPER(code) = UPPER($1)', [coupon.trim()])).rows[0];
        if (!couponData) return res.status(404).json({ error: 'Coupon not found' });
        if (!couponData.used) return res.json({ used: false, message: 'Coupon has not been used yet' });
        const user = (await pool.query('SELECT id, username, email, phone_number, activity_wallet, referral_wallet, coupon_code, plan, is_banned FROM users WHERE id = $1', [couponData.used_by])).rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ user_id: user.id, username: user.username, email: user.email, phone_number: user.phone_number, activity_wallet: user.activity_wallet, referral_wallet: user.referral_wallet, coupon_plan: user.plan, is_banned: user.is_banned, used: true });
    } catch (err) { console.error('Search coupon error:', err); res.status(500).json({ error: 'Database error' }); }
});

app.post('/api/admin/change-user-password', isAdmin, async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only Super Admin can change user passwords' });
    const { user_id, new_password } = req.body;
    if (!user_id || !new_password) return res.status(400).json({ error: 'User ID and new password are required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    try {
        const result = await pool.query('UPDATE users SET password = $1 WHERE id = $2 RETURNING username', [hashPassword(new_password), user_id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
        await createNotification(user_id, '🔐 Your password was changed by an administrator.');
        res.json({ success: true, message: `Password changed for ${result.rows[0].username}` });
    } catch (err) { console.error('Admin change password error:', err); res.status(500).json({ error: 'Failed to change password' }); }
});

app.post('/api/admin/credit-wallet', isAdmin, async (req, res) => {
    const { user_id, wallet_type, amount, reason } = req.body;
    if (!user_id || !wallet_type || !amount || amount <= 0) return res.status(400).json({ error: 'User ID, wallet type, and positive amount are required' });
    const column = wallet_type === 'activity' ? 'activity_wallet' : wallet_type === 'referral' ? 'referral_wallet' : null;
    if (!column) return res.status(400).json({ error: 'Invalid wallet type. Use activity or referral' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const userResult = await client.query('SELECT username FROM users WHERE id = $1', [user_id]);
        if (userResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
        await client.query(`UPDATE users SET ${column} = ${column} + $1 WHERE id = $2`, [amount, user_id]);
        await client.query('COMMIT');
        await addActivityFeed(user_id, 'Admin Credit', amount, reason || `Credited by admin to ${wallet_type}`);
        await createNotification(user_id, `💰 Admin credited ¥${amount.toLocaleString()} to your ${wallet_type} wallet.`);
        res.json({ success: true, message: `Credited ¥${amount} to ${wallet_type} wallet` });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Credit wallet error:', err); res.status(500).json({ error: 'Failed to credit wallet' }); }
    finally { if (client) client.release(); }
});

app.post('/api/admin/debit-wallet', isAdmin, async (req, res) => {
    const { user_id, wallet_type, amount, reason } = req.body;
    if (!user_id || !wallet_type || !amount || amount <= 0) return res.status(400).json({ error: 'User ID, wallet type, and positive amount are required' });
    const column = wallet_type === 'activity' ? 'activity_wallet' : wallet_type === 'referral' ? 'referral_wallet' : null;
    if (!column) return res.status(400).json({ error: 'Invalid wallet type. Use activity or referral' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const userResult = await client.query(`SELECT username, ${column} FROM users WHERE id = $1 FOR UPDATE`, [user_id]);
        if (userResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
        const balance = parseFloat(userResult.rows[0][column]) || 0;
        if (balance < amount) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Insufficient balance. Available: ¥${balance}` }); }
        await client.query(`UPDATE users SET ${column} = ${column} - $1 WHERE id = $2`, [amount, user_id]);
        await client.query('COMMIT');
        await addActivityFeed(user_id, 'Admin Debit', amount, reason || `Debited by admin from ${wallet_type}`);
        await createNotification(user_id, `⚠️ Admin debited ¥${amount.toLocaleString()} from your ${wallet_type} wallet.`);
        res.json({ success: true, message: `Debited ¥${amount} from ${wallet_type} wallet` });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Debit wallet error:', err); res.status(500).json({ error: 'Failed to debit wallet' }); }
    finally { if (client) client.release(); }
});

app.get('/api/admin/search-tiktok-user', isAdmin, async (req, res) => {
    const { search } = req.query;
    if (!search || search.trim().length === 0) return res.status(400).json({ error: 'Search term required' });
    const cleanSearch = search.trim().toLowerCase();
    try {
        const result = await pool.query(`SELECT ts.user_id, ts.tiktok_handle, u.username, u.tiktok_wallet FROM tiktok_submissions ts JOIN users u ON ts.user_id = u.id WHERE LOWER(u.username) LIKE $1 OR LOWER(ts.tiktok_handle) LIKE $1 LIMIT 5`, [`%${cleanSearch}%`]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const user = result.rows[0];
        res.json({ user_id: user.user_id, username: user.username, tiktok_handle: user.tiktok_handle, tiktok_wallet: user.tiktok_wallet || 0 });
    } catch (err) { console.error('TikTok search error:', err); res.status(500).json({ error: 'Search failed' }); }
});

app.post('/api/admin/add-tiktok-bonus', isAdmin, async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only Super Admin can add bonuses' });
    const { user_id, amount } = req.body;
    if (!user_id || !amount || amount <= 0) return res.status(400).json({ error: 'User ID and amount are required' });
    try {
        const result = await pool.query('UPDATE users SET tiktok_wallet = tiktok_wallet + $1 WHERE id = $2 RETURNING username', [amount, user_id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        await createNotification(user_id, `💰 You received $${amount} TikTok bonus!`);
        await addActivityFeed(user_id, 'TikTok Bonus', amount, `Admin added $${amount} TikTok bonus`);
        res.json({ message: `$${amount} added to ${result.rows[0].username}'s TikTok wallet` });
    } catch (err) { console.error('TikTok bonus error:', err); res.status(500).json({ error: 'Failed to add bonus' }); }
});

app.get('/api/admin/tiktok-users', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT ts.id, u.id as user_id, u.username, ts.tiktok_handle, ts.created_at FROM tiktok_submissions ts JOIN users u ON ts.user_id = u.id ORDER BY ts.created_at DESC`);
        res.json(result.rows);
    } catch (err) { console.error('TikTok users error:', err); res.status(500).json({ error: 'Failed to load TikTok users' }); }
});

app.post('/api/admin/add-social-link', isAdmin, async (req, res) => {
    const { platform, url } = req.body;
    if (!platform || !url) return res.status(400).json({ error: 'Platform and URL are required' });
    let cleanUrl = url.trim();
    if (!/^https?:\/\//i.test(cleanUrl)) cleanUrl = 'https://' + cleanUrl;
    const iconMap = { 'whatsapp': 'bi bi-whatsapp', 'telegram': 'bi bi-telegram', 'facebook': 'bi bi-facebook', 'instagram': 'bi bi-instagram', 'youtube': 'bi bi-youtube', 'twitter': 'bi bi-twitter', 'tiktok': 'bi bi-tiktok' };
    const iconClass = iconMap[platform.toLowerCase()] || 'bi bi-link-45deg';
    try {
        const exists = await pool.query('SELECT id FROM social_links WHERE LOWER(platform) = LOWER($1)', [platform.trim()]);
        if (exists.rows.length > 0) return res.status(400).json({ error: `A link for ${platform} already exists. Delete it first to update.` });
        const result = await pool.query('INSERT INTO social_links (platform, url, icon_class) VALUES ($1, $2, $3) RETURNING id', [platform.trim(), cleanUrl, iconClass]);
        res.status(201).json({ success: true, message: `${platform} link added successfully`, link_id: result.rows[0].id });
    } catch (err) { console.error('Add social link error:', err.message); res.status(500).json({ error: 'Failed to add link' }); }
});

app.get('/api/admin/social-links-stats', isAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, platform, url, icon_class FROM social_links ORDER BY platform ASC');
        res.json(result.rows);
    } catch (err) { console.error('Get social links error:', err); res.status(500).json({ error: 'Failed to load social links' }); }
});

app.delete('/api/admin/delete-social-link/:id', isAdmin, async (req, res) => {
    const linkId = parseInt(req.params.id);
    if (!linkId) return res.status(400).json({ error: 'Invalid link ID' });
    try {
        const result = await pool.query('DELETE FROM social_links WHERE id = $1 RETURNING id', [linkId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Link not found' });
        res.json({ message: 'Link deleted successfully' });
    } catch (err) { console.error('Delete link error:', err); res.status(500).json({ error: 'Failed to delete link' }); }
});

// ============================================================
// 👤 ASSISTANT ADMIN ENDPOINTS (CONSOLIDATED)
// ============================================================
app.get('/api/assistant/country-stats', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT UPPER(country) as country, COUNT(*)::int as count FROM users WHERE country IS NOT NULL AND is_banned = false AND is_admin = false GROUP BY UPPER(country) ORDER BY count DESC`);
        const countryData = { 'Nigeria': 0, 'Ghana': 0, 'Cameroon': 0, 'Other': 0 };
        let total = 0;
        result.rows.forEach(row => {
            const code = row.country ? row.country.trim() : '';
            if (code === 'NG') countryData['Nigeria'] = row.count;
            else if (code === 'GH') countryData['Ghana'] = row.count;
            else if (code === 'CM') countryData['Cameroon'] = row.count;
            else if (code) countryData['Other'] += row.count;
            total += row.count;
        });
        res.json({ Nigeria: countryData.Nigeria, Ghana: countryData.Ghana, Cameroon: countryData.Cameroon, Other: countryData.Other, total: total });
    } catch (err) { console.error('Assistant country stats error:', err); res.status(500).json({ error: 'Failed to load country stats' }); }
});

app.get('/api/assistant/stats', isAdmin, async (req, res) => {
    try {
        const usersResult = await pool.query('SELECT COUNT(*)::int as total FROM users WHERE id >= 1 AND is_banned = false');
        const payoutResult = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE status = 'completed'");
        const tasksResult = await pool.query('SELECT COUNT(*)::int as total FROM task_completions');
        const videosResult = await pool.query('SELECT COUNT(*)::int as total FROM video_completions');
        res.json({ total_users: usersResult.rows[0].total, total_payout: parseFloat(payoutResult.rows[0].total), total_tasks: tasksResult.rows[0].total, total_videos: videosResult.rows[0].total });
    } catch (err) { console.error('Assistant stats error:', err); res.status(500).json({ error: 'Failed to load stats' }); }
});

app.post('/api/assistant/generate-lite-coupon', isAdmin, async (req, res) => {
    const { count } = req.body;
    if (!count || count < 1) return res.status(400).json({ error: 'Count is required' });
    try {
        const coupons = [];
        for (let i = 0; i < count; i++) {
            const randomPart = Math.random().toString(36).substring(2, 10).toUpperCase().padEnd(8, '0');
            const code = `LITE${randomPart}`;
            await pool.query('INSERT INTO coupon_codes (code, plan, used) VALUES ($1, $2, false)', [code, 'YENLITE']);
            coupons.push(code);
        }
        res.json({ success: true, message: `${count} coupon(s) generated for YENLITE`, coupons: coupons, prefix: 'LITE', plan: 'YENLITE' });
    } catch (err) { console.error('Generate LITE coupon error:', err); res.status(500).json({ error: 'Failed to generate coupons' }); }
});

app.post('/api/assistant/generate-coupon', isAdmin, async (req, res) => {
    const { plan, count } = req.body;
    if (!plan || !count || count < 1) return res.status(400).json({ error: 'Plan and count are required' });
    const planPrefixes = { 'YENLITE': 'LITE', 'YENPRO': 'PRO', 'YENVITE': 'VITE' };
    const prefix = planPrefixes[plan];
    if (!prefix) return res.status(400).json({ error: 'Invalid plan. Use YENLITE, YENPRO, or YENVITE' });
    try {
        const coupons = [];
        for (let i = 0; i < count; i++) {
            const randomPart = Math.random().toString(36).substring(2, 10).toUpperCase().padEnd(8, '0');
            const code = `${prefix}${randomPart}`;
            await pool.query('INSERT INTO coupon_codes (code, plan, used) VALUES ($1, $2, false)', [code, plan]);
            coupons.push(code);
        }
        res.json({ success: true, message: `${count} coupon(s) generated for ${plan}`, coupons: coupons, prefix: prefix, plan: plan });
    } catch (err) { console.error('Assistant generate coupon error:', err); res.status(500).json({ error: 'Failed to generate coupons' }); }
});

app.post('/api/assistant/post-task', isAdmin, async (req, res) => {
    const { title, description, link } = req.body || {};
    if (!title?.trim() || !description?.trim() || !link?.trim()) return res.status(400).json({ error: 'Title, description, and link are required' });
    try {
        const result = await pool.query('INSERT INTO tasks (title, description, link) VALUES ($1, $2, $3) RETURNING id', [title.trim(), description.trim(), link.trim()]);
        res.status(201).json({ success: true, message: 'Task posted successfully', task_id: result.rows[0].id });
    } catch (err) { console.error('Assistant post task error:', err); res.status(500).json({ error: 'Failed to post task' }); }
});

app.get('/api/assistant/tasks', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT t.id, t.title, t.description, t.link, t.created_at, (SELECT COUNT(*)::int FROM task_completions tc WHERE tc.task_id = t.id) as completion_count FROM tasks t ORDER BY t.created_at DESC LIMIT 500`);
        res.json(result.rows);
    } catch (err) { console.error('Assistant tasks list error:', err); res.status(500).json({ error: 'Failed to load tasks' }); }
});

app.delete('/api/assistant/delete-task/:id', isAdmin, async (req, res) => {
    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) return res.status(400).json({ error: 'Invalid task ID' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query('DELETE FROM task_completions WHERE task_id = $1', [taskId]);
        const result = await client.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [taskId]);
        if (result.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Task not found' }); }
        await client.query('COMMIT');
        res.json({ success: true, message: 'Task and completions deleted successfully' });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Assistant delete task error:', err); res.status(500).json({ error: 'Failed to delete task' }); }
    finally { if (client) client.release(); }
});

app.post('/api/assistant/post-video', isAdmin, async (req, res) => {
    const { title, url } = req.body;
    if (!title || !url) return res.status(400).json({ error: 'Title and URL are required' });
    try {
        const result = await pool.query('INSERT INTO videos (title, url) VALUES ($1, $2) RETURNING id', [title.trim(), url.trim()]);
        res.status(201).json({ message: 'Video posted successfully', video_id: result.rows[0].id });
    } catch (err) { console.error('Assistant post video error:', err); res.status(500).json({ error: 'Failed to post video' }); }
});

app.get('/api/assistant/videos', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT v.id, v.title, v.url, v.created_at, COUNT(vc.id)::int as completion_count FROM videos v LEFT JOIN video_completions vc ON v.id = vc.video_id GROUP BY v.id ORDER BY v.created_at DESC LIMIT 500`);
        res.json(result.rows);
    } catch (err) { console.error('Assistant videos list error:', err); res.status(500).json({ error: 'Failed to load videos' }); }
});

app.delete('/api/assistant/delete-video/:id', isAdmin, async (req, res) => {
    const videoId = parseInt(req.params.id);
    if (!videoId) return res.status(400).json({ error: 'Invalid video ID' });
    try {
        await pool.query('DELETE FROM video_completions WHERE video_id = $1', [videoId]);
        const result = await pool.query('DELETE FROM videos WHERE id = $1 RETURNING id', [videoId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Video not found' });
        res.json({ message: 'Video deleted successfully' });
    } catch (err) { console.error('Assistant delete video error:', err); res.status(500).json({ error: 'Failed to delete video' }); }
});

app.post('/api/assistant/post-quiz', isAdmin, async (req, res) => {
    const { question, option_a, option_b, option_c, option_d, correct_answer } = req.body;
    if (!question || !option_a || !option_b || !option_c || !option_d || !correct_answer) return res.status(400).json({ error: 'All fields are required' });
    const validAnswer = correct_answer.toUpperCase();
    if (!['A', 'B', 'C', 'D'].includes(validAnswer)) return res.status(400).json({ error: 'Correct answer must be A, B, C, or D' });
    try {
        const result = await pool.query(`INSERT INTO quizzes (question, option_a, option_b, option_c, option_d, correct_answer) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [question.trim(), option_a.trim(), option_b.trim(), option_c.trim(), option_d.trim(), validAnswer]);
        res.status(201).json({ message: 'Quiz posted successfully', quiz_id: result.rows[0].id });
    } catch (err) { console.error('Assistant post quiz error:', err); res.status(500).json({ error: 'Failed to post quiz' }); }
});

app.get('/api/assistant/quizzes', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT q.id, q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_answer, q.created_at, COUNT(qc.id)::int as total_attempts, COALESCE(SUM(CASE WHEN qc.is_correct = true THEN 1 ELSE 0 END), 0)::int as correct_answers FROM quizzes q LEFT JOIN quiz_completions qc ON q.id = qc.quiz_id GROUP BY q.id ORDER BY q.created_at DESC LIMIT 500`);
        res.json(result.rows);
    } catch (err) { console.error('Assistant quizzes list error:', err); res.status(500).json({ error: 'Failed to load quizzes' }); }
});

app.delete('/api/assistant/delete-quiz/:id', isAdmin, async (req, res) => {
    const quizId = parseInt(req.params.id);
    if (!quizId) return res.status(400).json({ error: 'Invalid quiz ID' });
    try {
        await pool.query('DELETE FROM quiz_completions WHERE quiz_id = $1', [quizId]);
        const result = await pool.query('DELETE FROM quizzes WHERE id = $1 RETURNING id', [quizId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Quiz not found' });
        res.json({ message: 'Quiz deleted successfully' });
    } catch (err) { console.error('Assistant delete quiz error:', err); res.status(500).json({ error: 'Failed to delete quiz' }); }
});

app.post('/api/assistant/post-article', isAdmin, async (req, res) => {
    const { title, content, read_time } = req.body;
    if (!title || !content || !read_time) return res.status(400).json({ error: 'Title, content, and read_time are required' });
    const readTimeInt = parseInt(read_time);
    if (isNaN(readTimeInt) || readTimeInt <= 0) return res.status(400).json({ error: 'Read time must be a positive integer' });
    try {
        const result = await pool.query('INSERT INTO articles (title, content, read_time) VALUES ($1, $2, $3) RETURNING id', [title.trim(), content.trim(), readTimeInt]);
        res.status(201).json({ message: 'Article posted successfully', article_id: result.rows[0].id });
    } catch (err) { console.error('Assistant post article error:', err); res.status(500).json({ error: 'Failed to post article' }); }
});

app.get('/api/assistant/articles', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT a.id, a.title, a.read_time, a.created_at, COUNT(ac.id)::int as read_count FROM articles a LEFT JOIN article_completions ac ON a.id = ac.article_id GROUP BY a.id ORDER BY a.created_at DESC LIMIT 500`);
        res.json(result.rows);
    } catch (err) { console.error('Assistant articles list error:', err); res.status(500).json({ error: 'Failed to load articles' }); }
});

app.delete('/api/assistant/delete-article/:id', isAdmin, async (req, res) => {
    const articleId = parseInt(req.params.id);
    if (!articleId) return res.status(400).json({ error: 'Invalid article ID' });
    try {
        await pool.query('DELETE FROM article_completions WHERE article_id = $1', [articleId]);
        const result = await pool.query('DELETE FROM articles WHERE id = $1 RETURNING id', [articleId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Article not found' });
        res.json({ message: 'Article deleted successfully' });
    } catch (err) { console.error('Assistant delete article error:', err); res.status(500).json({ error: 'Failed to delete article' }); }
});

app.get('/api/assistant/search-user', isAdmin, async (req, res) => {
    const { q, type } = req.query;
    if (!q || !q.trim()) return res.status(400).json({ error: 'Search query (q) is required' });
    const cleanQuery = q.trim();
    try {
        let user;
        if (type === 'coupon') {
            const couponData = (await pool.query('SELECT id, used, plan, used_by FROM coupon_codes WHERE UPPER(code) = UPPER($1)', [cleanQuery])).rows[0];
            if (!couponData) return res.status(404).json({ error: 'Coupon not found' });
            if (!couponData.used) return res.json({ used: false, message: 'Coupon has not been used yet', coupon_plan: couponData.plan });
            user = (await pool.query('SELECT id, username, email, phone_number, activity_wallet, referral_wallet, tiktok_wallet, coupon_code, plan, is_banned, country, created_at FROM users WHERE id = $1', [couponData.used_by])).rows[0];
        } else {
            user = (await pool.query('SELECT id, username, email, phone_number, activity_wallet, referral_wallet, tiktok_wallet, coupon_code, plan, is_banned, country, created_at FROM users WHERE LOWER(username) = LOWER($1)', [cleanQuery])).rows[0];
        }
        if (!user) return res.status(404).json({ error: 'User not found' });
        const referralCount = (await pool.query('SELECT COUNT(*)::int as count FROM users WHERE referrer_id = $1', [user.id])).rows[0].count;
        res.json({
            user_id: user.id, username: user.username, email: user.email, phone_number: user.phone_number,
            activity_wallet: parseFloat(user.activity_wallet) || 0, referral_wallet: parseFloat(user.referral_wallet) || 0,
            tiktok_wallet: parseFloat(user.tiktok_wallet) || 0, coupon_code: user.coupon_code, plan: user.plan,
            is_banned: user.is_banned, country: user.country, referral_count: referralCount, created_at: user.created_at
        });
    } catch (err) { console.error('Assistant search user error:', err); res.status(500).json({ error: 'Search failed' }); }
});

app.get('/api/assistant/withdrawal-requests', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT w.id, u.username, u.country, w.amount, w.wallet_type, w.bank_name, w.account_number, w.status, TO_CHAR(w.created_at, 'DD Mon, HH:MI AM') as request_date FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = 'pending' ORDER BY w.created_at DESC`);
        res.json(result.rows);
    } catch (err) { console.error('Assistant withdrawal error:', err); res.status(500).json({ error: 'Failed to load withdrawals' }); }
});

app.post('/api/assistant/approve-withdrawal/:id', isAdmin, async (req, res) => {
    try {
        const result = await pool.query("UPDATE withdrawals SET status = 'completed' WHERE id = $1 RETURNING user_id, amount, wallet_type", [req.params.id]);
        const row = result.rows[0];
        if (!row) return res.status(404).json({ error: 'Withdrawal not found' });
        const currencySymbol = row.wallet_type === 'tiktok' ? '$' : '¥';
        await createNotification(row.user_id, `✅ Your withdrawal of ${currencySymbol}${parseFloat(row.amount).toLocaleString()} has been approved!`);
        await addActivityFeed(row.user_id, 'Withdrawal Approved', row.amount, 'Funds sent to your bank');
        res.json({ success: true, message: 'Withdrawal approved successfully' });
    } catch (err) { console.error('Assistant approval error:', err); res.status(500).json({ error: 'Failed to approve withdrawal' }); }
});

app.post('/api/assistant/reject-withdrawal/:id', isAdmin, async (req, res) => {
    const { reason } = req.body;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const resW = await client.query("UPDATE withdrawals SET status = 'rejected' WHERE id = $1 AND status = 'pending' RETURNING user_id, amount, wallet_type", [req.params.id]);
        const w = resW.rows[0];
        if (!w) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pending withdrawal not found or already processed' }); }
        const allowedWallets = { 'activity': 'activity_wallet', 'referral': 'referral_wallet', 'tiktok': 'tiktok_wallet' };
        const walletColumn = allowedWallets[w.wallet_type];
        if (!walletColumn) throw new Error('Invalid wallet type in record');
        await client.query(`UPDATE users SET ${walletColumn} = ${walletColumn} + $1 WHERE id = $2`, [w.amount, w.user_id]);
        await client.query('COMMIT');
        const currency = w.wallet_type === 'tiktok' ? '$' : '¥';
        await createNotification(w.user_id, `❌ Withdrawal rejected: ${reason || 'No reason provided'}. ${currency}${parseFloat(w.amount).toLocaleString()} refunded.`);
        await addActivityFeed(w.user_id, 'Withdrawal Rejected', w.amount, `Rejected by assistant: ${reason || 'No reason'}`);
        res.json({ success: true, message: 'Withdrawal rejected and funds refunded' });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Assistant reject error:', err); res.status(500).json({ error: 'Failed to reject withdrawal' }); }
    finally { if (client) client.release(); }
});

app.post('/api/assistant/change-user-password', isAdmin, async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only Super Admin can change user passwords' });
    const { user_id, new_password } = req.body;
    if (!user_id || !new_password) return res.status(400).json({ error: 'User ID and new password are required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    try {
        const result = await pool.query('UPDATE users SET password = $1 WHERE id = $2 RETURNING username', [hashPassword(new_password), user_id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
        await createNotification(user_id, '🔐 Your password was changed by an administrator.');
        res.json({ success: true, message: `Password changed for ${result.rows[0].username}` });
    } catch (err) { console.error('Assistant change password error:', err); res.status(500).json({ error: 'Failed to change password' }); }
});

app.post('/api/assistant/credit-wallet', isAdmin, async (req, res) => {
    const { user_id, wallet_type, amount, reason } = req.body;
    if (!user_id || !wallet_type || !amount || amount <= 0) return res.status(400).json({ error: 'User ID, wallet type, and positive amount are required' });
    const column = wallet_type === 'activity' ? 'activity_wallet' : wallet_type === 'referral' ? 'referral_wallet' : null;
    if (!column) return res.status(400).json({ error: 'Invalid wallet type. Use activity or referral' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const userResult = await client.query('SELECT username FROM users WHERE id = $1', [user_id]);
        if (userResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
        await client.query(`UPDATE users SET ${column} = ${column} + $1 WHERE id = $2`, [amount, user_id]);
        await client.query('COMMIT');
        await addActivityFeed(user_id, 'Admin Credit', amount, reason || `Credited by assistant to ${wallet_type}`);
        await createNotification(user_id, `💰 Assistant credited ¥${amount.toLocaleString()} to your ${wallet_type} wallet.`);
        res.json({ success: true, message: `Credited ¥${amount} to ${wallet_type} wallet` });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Assistant credit wallet error:', err); res.status(500).json({ error: 'Failed to credit wallet' }); }
    finally { if (client) client.release(); }
});

app.post('/api/assistant/debit-wallet', isAdmin, async (req, res) => {
    const { user_id, wallet_type, amount, reason } = req.body;
    if (!user_id || !wallet_type || !amount || amount <= 0) return res.status(400).json({ error: 'User ID, wallet type, and positive amount are required' });
    const column = wallet_type === 'activity' ? 'activity_wallet' : wallet_type === 'referral' ? 'referral_wallet' : null;
    if (!column) return res.status(400).json({ error: 'Invalid wallet type. Use activity or referral' });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const userResult = await client.query(`SELECT username, ${column} FROM users WHERE id = $1 FOR UPDATE`, [user_id]);
        if (userResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
        const balance = parseFloat(userResult.rows[0][column]) || 0;
        if (balance < amount) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Insufficient balance. Available: ¥${balance}` }); }
        await client.query(`UPDATE users SET ${column} = ${column} - $1 WHERE id = $2`, [amount, user_id]);
        await client.query('COMMIT');
        await addActivityFeed(user_id, 'Admin Debit', amount, reason || `Debited by assistant from ${wallet_type}`);
        await createNotification(user_id, `⚠️ Assistant debited ¥${amount.toLocaleString()} from your ${wallet_type} wallet.`);
        res.json({ success: true, message: `Debited ¥${amount} from ${wallet_type} wallet` });
    } catch (err) { if (client) await client.query('ROLLBACK'); console.error('Assistant debit wallet error:', err); res.status(500).json({ error: 'Failed to debit wallet' }); }
    finally { if (client) client.release(); }
});

app.get('/api/assistant/search-tiktok-user', isAdmin, async (req, res) => {
    const { search } = req.query;
    if (!search || search.trim().length === 0) return res.status(400).json({ error: 'Search term required' });
    const cleanSearch = search.trim().toLowerCase();
    try {
        const result = await pool.query(`SELECT ts.user_id, ts.tiktok_handle, u.username, u.tiktok_wallet FROM tiktok_submissions ts JOIN users u ON ts.user_id = u.id WHERE LOWER(u.username) LIKE $1 OR LOWER(ts.tiktok_handle) LIKE $1 LIMIT 5`, [`%${cleanSearch}%`]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const user = result.rows[0];
        res.json({ user_id: user.user_id, username: user.username, tiktok_handle: user.tiktok_handle, tiktok_wallet: user.tiktok_wallet || 0 });
    } catch (err) { console.error('TikTok search error:', err); res.status(500).json({ error: 'Search failed' }); }
});

app.post('/api/assistant/add-tiktok-bonus', isAdmin, async (req, res) => {
    const { user_id, amount } = req.body;
    if (!user_id || !amount || amount <= 0) return res.status(400).json({ error: 'User ID and positive amount are required' });
    try {
        const result = await pool.query('UPDATE users SET tiktok_wallet = tiktok_wallet + $1 WHERE id = $2 RETURNING username', [amount, user_id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        await createNotification(user_id, `💰 You received $${amount} TikTok bonus from admin!`);
        await addActivityFeed(user_id, 'TikTok Bonus', amount, `Assistant added $${amount} TikTok bonus`);
        res.json({ success: true, message: `$${amount} added to ${result.rows[0].username}'s TikTok wallet` });
    } catch (err) { console.error('Assistant TikTok bonus error:', err); res.status(500).json({ error: 'Failed to add bonus' }); }
});

app.get('/api/assistant/tiktok-users', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT ts.id, u.id as user_id, u.username, ts.tiktok_handle, ts.created_at FROM tiktok_submissions ts JOIN users u ON ts.user_id = u.id ORDER BY ts.created_at DESC`);
        res.json(result.rows);
    } catch (err) { console.error('TikTok users error:', err); res.status(500).json({ error: 'Failed to load TikTok users' }); }
});

app.post('/api/assistant/add-social-link', isAdmin, async (req, res) => {
    const { platform, url } = req.body;
    if (!platform || !url) return res.status(400).json({ error: 'Platform and URL are required' });
    let cleanUrl = url.trim();
    if (!/^https?:\/\//i.test(cleanUrl)) cleanUrl = 'https://' + cleanUrl;
    const iconMap = { 'whatsapp': 'bi bi-whatsapp', 'telegram': 'bi bi-telegram', 'facebook': 'bi bi-facebook', 'instagram': 'bi bi-instagram', 'youtube': 'bi bi-youtube', 'twitter': 'bi bi-twitter', 'tiktok': 'bi bi-tiktok' };
    const iconClass = iconMap[platform.toLowerCase()] || 'bi bi-link-45deg';
    try {
        const exists = await pool.query('SELECT id FROM social_links WHERE LOWER(platform) = LOWER($1)', [platform.trim()]);
        if (exists.rows.length > 0) return res.status(400).json({ error: `A link for ${platform} already exists. Delete it first to update.` });
        const result = await pool.query('INSERT INTO social_links (platform, url, icon_class) VALUES ($1, $2, $3) RETURNING id', [platform.trim(), cleanUrl, iconClass]);
        res.status(201).json({ success: true, message: `${platform} link added successfully`, link_id: result.rows[0].id });
    } catch (err) { console.error('Assistant add social link error:', err.message); res.status(500).json({ error: 'Failed to add link' }); }
});

app.get('/api/assistant/social-links', isAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, platform, url, icon_class FROM social_links ORDER BY platform ASC');
        res.json(result.rows);
    } catch (err) { console.error('Assistant get social links error:', err); res.status(500).json({ error: 'Failed to load social links' }); }
});

app.delete('/api/assistant/delete-social-link/:id', isAdmin, async (req, res) => {
    const linkId = parseInt(req.params.id);
    if (!linkId) return res.status(400).json({ error: 'Invalid link ID' });
    try {
        const result = await pool.query('DELETE FROM social_links WHERE id = $1 RETURNING id', [linkId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Link not found' });
        res.json({ message: 'Link deleted successfully' });
    } catch (err) { console.error('Assistant delete link error:', err); res.status(500).json({ error: 'Failed to delete link' }); }
});

app.get('/api/assistant/get-withdrawal-settings', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`SELECT activity_withdrawal_enabled, referral_withdrawal_enabled, tiktok_withdrawal_enabled, active_country FROM settings WHERE id = 1`);
        const settings = result.rows[0] || { activity_withdrawal_enabled: false, referral_withdrawal_enabled: false, tiktok_withdrawal_enabled: false, active_country: 'NG' };
        res.json(settings);
    } catch (err) { console.error('Assistant settings error:', err); res.status(500).json({ error: 'Failed to load settings' }); }
});

app.post('/api/assistant/toggle-withdrawal', isAdmin, async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only Super Admin can change site settings' });
    const { wallet_type, enabled } = req.body;
    const columnMap = { 'activity': 'activity_withdrawal_enabled', 'referral': 'referral_withdrawal_enabled', 'tiktok': 'tiktok_withdrawal_enabled' };
    const column = columnMap[wallet_type];
    if (!column) return res.status(400).json({ error: 'Invalid wallet type' });
    const isEnabled = Boolean(enabled);
    try {
        await pool.query(`INSERT INTO settings (id, ${column}) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET ${column} = EXCLUDED.${column}`, [isEnabled]);
        res.json({ message: `${wallet_type.toUpperCase()} withdrawal ${isEnabled ? 'Enabled' : 'Disabled'}` });
    } catch (err) { console.error('Assistant toggle error:', err); res.status(500).json({ error: 'Failed to update settings' }); }
});

app.post('/api/assistant/update-active-country', isAdmin, async (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only Super Admin can change the active country' });
    const { country } = req.body;
    if (!country) return res.status(400).json({ error: 'Country code is required' });
    try {
        const s = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
        if (s && (s.activity_withdrawal_enabled || s.referral_withdrawal_enabled || s.tiktok_withdrawal_enabled)) return res.status(400).json({ error: 'Cannot change country! Please turn OFF all withdrawal switches first.' });
        await pool.query(`INSERT INTO settings (id, active_country) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET active_country = EXCLUDED.active_country`, [country.trim().toUpperCase()]);
        res.json({ message: `Active country successfully set to ${country}` });
    } catch (err) { console.error('Assistant update country error:', err); res.status(500).json({ error: 'Database update failed' }); }
});

// ============================================================
// 📊 PUBLIC STATS (for index.html landing page)
// ============================================================
app.get('/api/public/stats', async (req, res) => {
    try {
        const usersResult = await pool.query('SELECT COUNT(*)::int as total FROM users WHERE id >= 1 AND is_banned = false');
        const payoutResult = await pool.query("SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE status = 'completed'");
        res.json({ total_users: usersResult.rows[0].total, total_payout: parseFloat(payoutResult.rows[0].total) });
    } catch (err) { console.error('Public stats error:', err); res.status(500).json({ error: 'Failed to load stats' }); }
});

// ============================================================
// ❌ ERROR HANDLING
// ============================================================
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ error: 'Internal server error', message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong' });
});

app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));

// ============================================================
// 🚀 START SERVER / EXPORT FOR VERCEL
// ============================================================
if (!process.env.VERCEL) {
    const server = app.listen(PORT, () => {
        console.log(`🚀 YENLLET Server running locally on port ${PORT}`);
    });

    process.on('SIGINT', () => {
        console.log('\n⏹️  Shutting down server...');
        server.close(() => {
            console.log('✅ Server closed');
            pool.end();
            console.log('✅ Database connection closed');
            process.exit(0);
        });
    });
}

module.exports = app;