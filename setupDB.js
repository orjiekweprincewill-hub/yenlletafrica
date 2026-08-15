const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

// ============================================================
// 🔌 POOL CONFIGURATION (Updated for Neon Serverless)
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
  keepAlive: true
});

pool.on('error', (err) => {
  console.error('Unexpected database pool idle exception:', err.message);
});

// ============================================================
// 🔧 HELPER FUNCTIONS
// ============================================================

function sha256(str) {
    return crypto.createHash('sha256').update(String(str)).digest('hex');
}

async function tableExists(client, tableName) {
    const res = await client.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
        [tableName]
    );
    return res.rows.length > 0;
}

async function columnExists(client, table, column) {
    const res = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
        [table, column]
    );
    return res.rows.length > 0;
}

async function addColumn(client, table, column, def) {
    const exists = await columnExists(client, table, column);
    if (!exists) {
        await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
        console.log(`   ➕ Added column: ${table}.${column}`);
    }
}

async function createIndex(client, name, table, cols, unique = false) {
    const res = await client.query(
        "SELECT 1 FROM pg_indexes WHERE indexname = $1",
        [name]
    );
    if (!res.rows.length) {
        const sql = `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${table} (${cols})`;
        await client.query(sql);
        console.log(`   📇 Created index: ${name}`);
    }
}

async function constraintExists(client, constraintName) {
    const res = await client.query(
        "SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = $1",
        [constraintName]
    );
    return res.rows.length > 0;
}

// ============================================================
// 🏗️ TABLE BUILDERS
// ============================================================

async function buildUsers(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            phone_number TEXT UNIQUE,
            password TEXT NOT NULL,
            coupon_code TEXT,
            referrer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            activity_wallet DECIMAL(15,2) DEFAULT 0,
            referral_wallet DECIMAL(15,2) DEFAULT 0,
            tiktok_wallet DECIMAL(15,2) DEFAULT 0,
            total_referral_earnings DECIMAL(15,2) DEFAULT 0,
            goshare_earnings DECIMAL(15,2) DEFAULT 0,
            country TEXT DEFAULT 'NG',
            bank_name TEXT,
            account_number TEXT,
            account_name TEXT,
            withdrawal_pin TEXT,
            profile_picture TEXT,
            plan TEXT DEFAULT 'YENLITE',
            last_spin DATE,
            is_banned BOOLEAN DEFAULT false,
            is_admin BOOLEAN DEFAULT false,
            role TEXT DEFAULT 'user',
            dark_mode BOOLEAN DEFAULT false,
            password_reset_token TEXT,
            password_reset_expires TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('   👤 Table verified or created: users');

    const cols = [
        ['email', 'TEXT UNIQUE'],
        ['phone_number', 'TEXT UNIQUE'],
        ['referrer_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
        ['activity_wallet', 'DECIMAL(15,2) DEFAULT 0'],
        ['referral_wallet', 'DECIMAL(15,2) DEFAULT 0'],
        ['tiktok_wallet', 'DECIMAL(15,2) DEFAULT 0'],
        ['total_referral_earnings', 'DECIMAL(15,2) DEFAULT 0'],
        ['goshare_earnings', 'DECIMAL(15,2) DEFAULT 0'],
        ['country', "TEXT DEFAULT 'NG'"],
        ['bank_name', 'TEXT'],
        ['account_number', 'TEXT'],
        ['account_name', 'TEXT'],
        ['withdrawal_pin', 'TEXT'],
        ['profile_picture', 'TEXT'],
        ['plan', "TEXT DEFAULT 'YENLITE'"],
        ['last_spin', 'DATE'],
        ['is_banned', 'BOOLEAN DEFAULT false'],
        ['is_admin', 'BOOLEAN DEFAULT false'],
        ['role', "TEXT DEFAULT 'user'"],
        ['dark_mode', 'BOOLEAN DEFAULT false'],
        ['password_reset_token', 'TEXT'],
        ['password_reset_expires', 'TIMESTAMP'],
        ['is_vendor', 'BOOLEAN DEFAULT false'],
        ['vendor_active', 'BOOLEAN DEFAULT true']
    ];
    for (const [col, def] of cols) await addColumn(client, 'users', col, def);

    await createIndex(client, 'idx_users_username', 'users', 'LOWER(username)');
    await createIndex(client, 'idx_users_email', 'users', 'LOWER(email)');
    await createIndex(client, 'idx_users_referrer', 'users', 'referrer_id');
    await createIndex(client, 'idx_users_role', 'users', 'role');
    await createIndex(client, 'idx_users_banned', 'users', 'is_banned');
    await createIndex(client, 'idx_users_plan', 'users', 'plan');
    await createIndex(client, 'idx_users_vendor', 'users', 'is_vendor');
    console.log('✅ users table ready');
}

async function buildSettings(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY DEFAULT 1,
            activity_withdrawal_enabled BOOLEAN DEFAULT true,
            referral_withdrawal_enabled BOOLEAN DEFAULT true,
            tiktok_withdrawal_enabled BOOLEAN DEFAULT true,
            active_country TEXT DEFAULT 'NG',
            whatsapp_reward_amount DECIMAL(10,2) DEFAULT 190,
            auto_delete_tasks_after_minutes INTEGER DEFAULT 1440,
            auto_delete_videos_after_minutes INTEGER DEFAULT 1440,
            CONSTRAINT single_settings CHECK (id = 1)
        );
    `);
    await client.query(`
        INSERT INTO settings (id, activity_withdrawal_enabled, referral_withdrawal_enabled, tiktok_withdrawal_enabled, active_country, auto_delete_tasks_after_minutes, auto_delete_videos_after_minutes)
        VALUES (1, true, true, true, 'NG', 1440, 1440)
        ON CONFLICT (id) DO NOTHING;
    `);
    console.log('✅ settings table ready');
}

async function buildCouponCodes(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS coupon_codes (
            id SERIAL PRIMARY KEY,
            code TEXT UNIQUE NOT NULL,
            plan TEXT DEFAULT 'YENLITE',
            used BOOLEAN DEFAULT false,
            used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await createIndex(client, 'idx_coupon_codes_code', 'coupon_codes', 'UPPER(code)', true);
    await createIndex(client, 'idx_coupon_codes_used', 'coupon_codes', 'used');
    console.log('✅ coupon_codes table ready');
}

async function buildTasks(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS tasks (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            link TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await createIndex(client, 'idx_tasks_created', 'tasks', 'created_at DESC');
    console.log('✅ tasks table ready');
}

async function buildTaskCompletions(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS task_completions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, task_id)
        );
    `);
    await createIndex(client, 'idx_task_comp_user', 'task_completions', 'user_id');
    await createIndex(client, 'idx_task_comp_task', 'task_completions', 'task_id');
    console.log('✅ task_completions table ready');
}

async function buildVideos(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS videos (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await createIndex(client, 'idx_videos_created', 'videos', 'created_at DESC');
    console.log('✅ videos table ready');
}

async function buildVideoCompletions(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS video_completions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, video_id)
        );
    `);
    await createIndex(client, 'idx_video_comp_user', 'video_completions', 'user_id');
    console.log('✅ video_completions table ready');
}

async function buildQuizzes(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS quizzes (
            id SERIAL PRIMARY KEY,
            question TEXT NOT NULL,
            option_a TEXT NOT NULL,
            option_b TEXT NOT NULL,
            option_c TEXT NOT NULL,
            option_d TEXT NOT NULL,
            correct_answer TEXT NOT NULL CHECK(correct_answer IN ('A', 'B', 'C', 'D')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('✅ quizzes table ready');
}

async function buildQuizCompletions(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS quiz_completions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
            user_answer TEXT NOT NULL,
            is_correct BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, quiz_id)
        );
    `);
    await createIndex(client, 'idx_quiz_comp_user', 'quiz_completions', 'user_id');
    console.log('✅ quiz_completions table ready');
}

async function buildArticles(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS articles (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            reward DECIMAL(15,2) DEFAULT 11,
            read_time INTEGER DEFAULT 15,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('✅ articles table ready');
}

async function buildArticleCompletions(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS article_completions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, article_id)
        );
    `);
    await createIndex(client, 'idx_article_comp_user', 'article_completions', 'user_id');
    console.log('✅ article_completions table ready');
}

async function buildWithdrawals(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS withdrawals (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            wallet_type TEXT NOT NULL,
            amount DECIMAL(15,2) NOT NULL,
            bank_name TEXT NOT NULL,
            account_number TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            country TEXT,
            currency TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await createIndex(client, 'idx_withdrawals_user', 'withdrawals', 'user_id');
    await createIndex(client, 'idx_withdrawals_status', 'withdrawals', 'status');
    await createIndex(client, 'idx_withdrawals_created', 'withdrawals', 'created_at DESC');
    console.log('✅ withdrawals table ready');
}

async function buildNotifications(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message TEXT NOT NULL,
            is_read BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await createIndex(client, 'idx_notif_user_read', 'notifications', 'user_id, is_read');
    await createIndex(client, 'idx_notif_created', 'notifications', 'created_at DESC');
    console.log('✅ notifications table ready');
}

async function buildActivityFeed(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS activity_feed (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            action TEXT NOT NULL,
            amount DECIMAL(15,2) DEFAULT 0,
            description TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await createIndex(client, 'idx_activity_user', 'activity_feed', 'user_id');
    await createIndex(client, 'idx_activity_created', 'activity_feed', 'created_at DESC');
    console.log('✅ activity_feed table ready');
}

async function buildSocialLinks(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS social_links (
            id SERIAL PRIMARY KEY,
            platform TEXT NOT NULL,
            url TEXT NOT NULL,
            icon_class TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);

    const ucRes = await client.query(
        "SELECT 1 FROM pg_indexes WHERE indexname = 'idx_social_platform'"
    );
    if (!ucRes.rows.length) {
        try {
            await client.query(`
                WITH ranked AS (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY LOWER(platform)
                        ORDER BY id
                    ) as rn
                    FROM social_links
                )
                DELETE FROM social_links WHERE id IN (
                    SELECT id FROM ranked WHERE rn > 1
                );
            `);
        } catch (e) {
            console.warn('⚠️ Social links deduplication skipped:', e.message);
        }
        await createIndex(client, 'idx_social_platform', 'social_links', 'LOWER(platform)', true);
    }

    console.log('✅ social_links table ready');
}

async function buildChatMessages(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
            id SERIAL PRIMARY KEY,
            sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message TEXT NOT NULL,
            read BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await addColumn(client, 'chat_messages', 'message_type', "TEXT DEFAULT 'text'");
    await addColumn(client, 'chat_messages', 'file_url', 'TEXT');
    await addColumn(client, 'chat_messages', 'file_name', 'TEXT');
    await addColumn(client, 'chat_messages', 'duration', 'INTEGER');

    await createIndex(client, 'idx_chat_msg_sender', 'chat_messages', 'sender_id');
    await createIndex(client, 'idx_chat_msg_receiver', 'chat_messages', 'receiver_id');
    await createIndex(client, 'idx_chat_msg_pair', 'chat_messages', 'sender_id, receiver_id');
    await createIndex(client, 'idx_chat_msg_created', 'chat_messages', 'created_at');
    console.log('✅ chat_messages table ready');
}

async function buildChatSessions(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            partner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            reward_paid BOOLEAN DEFAULT false,
            created_at DATE DEFAULT CURRENT_DATE
        );
    `);

    const colTypeRes = await client.query(`
        SELECT data_type FROM information_schema.columns 
        WHERE table_name = 'chat_sessions' AND column_name = 'created_at'
    `);
    
    if (colTypeRes.rows.length > 0 && colTypeRes.rows[0].data_type !== 'DATE') {
        try {
            await client.query(`
                ALTER TABLE chat_sessions
                ALTER COLUMN created_at TYPE DATE
                USING created_at::date;
            `);
            console.log('   🕛 Normalized chat_sessions.created_at to DATE');
        } catch (e) {
            console.warn('⚠️ Column type normalization skipped:', e.message);
        }
    }

    try {
        await client.query(`
            WITH ranked AS (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY user_id, partner_id, created_at
                    ORDER BY id
                ) as rn
                FROM chat_sessions
            )
            DELETE FROM chat_sessions WHERE id IN (
                SELECT id FROM ranked WHERE rn > 1
            );
        `);
        console.log('   🧹 Deduplicated chat_sessions');
    } catch (e) {
        console.warn('⚠️ Chat sessions deduplication skipped:', e.message);
    }

    const constraintName = 'chat_sessions_user_partner_date_unique';
    const constExists = await constraintExists(client, constraintName);
    
    if (!constExists) {
        await client.query(`
            ALTER TABLE chat_sessions
            ADD CONSTRAINT ${constraintName}
            UNIQUE (user_id, partner_id, created_at);
        `);
        console.log(`   🔒 Added unique constraint: ${constraintName}`);
    } else {
        console.log(`   🔒 Unique constraint already exists: ${constraintName}`);
    }

    console.log('✅ chat_sessions table ready');
}

async function buildUserOnlineStatus(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS user_online_status (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            last_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            is_online BOOLEAN DEFAULT false
        );
    `);
    console.log('✅ user_online_status table ready');
}

async function buildWhatsAppPosts(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_posts (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT,
            image_filename TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await createIndex(client, 'idx_whatsapp_user', 'whatsapp_posts', 'user_id');
    console.log('✅ whatsapp_posts table ready');
}

async function buildWhatsAppSubmissions(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_submissions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            post_id INTEGER NOT NULL REFERENCES whatsapp_posts(id) ON DELETE CASCADE,
            screenshot_filename TEXT NOT NULL,
            submission_status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('✅ whatsapp_submissions table ready');
}

async function buildTikTokSubmissions(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS tiktok_submissions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            tiktok_handle TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('✅ tiktok_submissions table ready');
}

async function buildMarketplaceSellers(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS marketplace_sellers (
            id SERIAL PRIMARY KEY,
            user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            email TEXT NOT NULL,
            phone_number TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('✅ marketplace_sellers table ready');
}

async function buildTransfers(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS transfers (
            id SERIAL PRIMARY KEY,
            sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            recipient_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            amount DECIMAL(15,2) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await createIndex(client, 'idx_transfers_sender', 'transfers', 'sender_id');
    await createIndex(client, 'idx_transfers_recipient', 'transfers', 'recipient_id');
    console.log('✅ transfers table ready');
}

async function buildPasswordResets(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS password_resets (
            id SERIAL PRIMARY KEY,
            email VARCHAR(255) NOT NULL,
            token VARCHAR(255) NOT NULL UNIQUE,
            expires_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await createIndex(client, 'idx_pw_reset_token', 'password_resets', 'token');
    await createIndex(client, 'idx_pw_reset_email', 'password_resets', 'email');
    console.log('✅ password_resets table ready');
}

// ============================================================
// 🎧 SUPPORT TICKETS TABLE BUILDERS
// ============================================================

async function buildSupportTickets(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS support_tickets (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            vendor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            subject VARCHAR(255) DEFAULT 'General Support',
            status VARCHAR(20) DEFAULT 'waiting',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            closed_at TIMESTAMP
        );
    `);
    await createIndex(client, 'idx_support_tickets_status', 'support_tickets', 'status');
    await createIndex(client, 'idx_support_tickets_user', 'support_tickets', 'user_id');
    await createIndex(client, 'idx_support_tickets_vendor', 'support_tickets', 'vendor_id');
    console.log('✅ support_tickets table ready');
}

async function buildSupportMessages(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS support_messages (
            id SERIAL PRIMARY KEY,
            ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
            sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            sender_type VARCHAR(10) NOT NULL,
            message TEXT,
            message_type VARCHAR(20) DEFAULT 'text',
            file_url VARCHAR(500),
            file_name VARCHAR(255),
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await createIndex(client, 'idx_support_messages_ticket', 'support_messages', 'ticket_id');
    await createIndex(client, 'idx_support_messages_created', 'support_messages', 'created_at');
    console.log('✅ support_messages table ready');
}

// ============================================================
// 📚 COURSES TABLE BUILDERS
// ============================================================

async function buildCourses(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS courses (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            image_url TEXT,
            telegram_link TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('✅ courses table ready');
}

async function buildCourseJoins(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS course_joins (
            id SERIAL PRIMARY KEY,
            course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) NOT NULL,
            phone VARCHAR(50) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(course_id, user_id)
        );
    `);
    await createIndex(client, 'idx_course_joins_course', 'course_joins', 'course_id');
    await createIndex(client, 'idx_course_joins_user', 'course_joins', 'user_id');
    console.log('✅ course_joins table ready');
}

// ============================================================
// 👤 SEED DATA
// ============================================================

async function seedAdmins(client) {
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@yenllet.local';
    const adminPass = sha256(process.env.ADMIN_PASSWORD || 'admin123');
    const adminPin = sha256(process.env.ADMIN_PIN || '0000');

    await client.query(`
        INSERT INTO users (username, email, phone_number, password, coupon_code, plan, is_admin, role, withdrawal_pin, country)
        VALUES ($1, $2, $3, $4, 'ADMIN00001', 'ADMIN', true, 'superadmin', $5, 'NG')
        ON CONFLICT (username) DO UPDATE SET
            email = EXCLUDED.email,
            phone_number = EXCLUDED.phone_number,
            password = EXCLUDED.password,
            role = 'superadmin',
            is_admin = true,
            is_banned = false,
            plan = 'ADMIN',
            withdrawal_pin = EXCLUDED.withdrawal_pin,
            country = EXCLUDED.country;
    `, [adminUser, adminEmail, '1234567890', adminPass, adminPin]);

    const assistantUser = process.env.ASSISTANT_ADMIN_USERNAME || 'helper_admin';
    const assistantEmail = process.env.ASSISTANT_ADMIN_EMAIL || 'helper@yenllet.local';
    const assistantPass = sha256(process.env.ASSISTANT_ADMIN_PASSWORD || 'helper123');
    const assistantPin = sha256(process.env.ASSISTANT_ADMIN_PIN || '0000');

    await client.query(`
        INSERT INTO users (username, email, phone_number, password, coupon_code, plan, is_admin, role, withdrawal_pin, country)
        VALUES ($1, $2, $3, $4, 'HELP00001', 'ADMIN', true, 'assistant', $5, 'NG')
        ON CONFLICT (username) DO UPDATE SET
            email = EXCLUDED.email,
            phone_number = EXCLUDED.phone_number,
            password = EXCLUDED.password,
            role = 'assistant',
            is_admin = true,
            is_banned = false,
            plan = 'ADMIN',
            withdrawal_pin = EXCLUDED.withdrawal_pin,
            country = EXCLUDED.country;
    `, [assistantUser, assistantEmail, '0987654321', assistantPass, assistantPin]);

    console.log(`✅ Super Admin: ${adminUser}`);
    console.log(`✅ Assistant Admin: ${assistantUser}`);
}

async function seedCoupons(client) {
    const coupons = [
        ['LITE12345', 'YENLITE'], ['LITE67890', 'YENLITE'],
        ['PRO12345', 'YENPRO'],   ['PRO67890', 'YENPRO'],
        ['VITE12345', 'YENVITE'], ['VITE67890', 'YENVITE'],
        ['UPGRADE001', 'YENPRO'], ['UPGRADE002', 'YENVITE']
    ];
    for (const [code, plan] of coupons) {
        await client.query(
            `INSERT INTO coupon_codes (code, plan, used) VALUES ($1, $2, false) ON CONFLICT (code) DO NOTHING`,
            [code, plan]
        );
    }
    console.log('✅ Sample coupons seeded');
}

async function seedSocialLinks(client) {
    const links = [
        ['WhatsApp', 'https://wa.me/234912345678', 'bi bi-whatsapp'],
        ['Telegram', 'https://t.me/yenllet', 'bi bi-telegram'],
        ['Facebook', 'https://facebook.com/yenllet', 'bi bi-facebook']
    ];
    for (const [platform, url, icon] of links) {
        await client.query(
            `INSERT INTO social_links (platform, url, icon_class) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [platform, url, icon]
        );
    }
    console.log('✅ Default social links seeded');
}

// ============================================================
// 🚀 MASTER MIGRATION
// ============================================================

async function setupDatabase() {
    let client;
    try {
        console.log(`\n🔌 Connecting to Neon Database...`);

        const testClient = await pool.connect();
        const testResult = await testClient.query('SELECT NOW() as now, version() as version');
        console.log(`✅ Connected! Server time: ${testResult.rows[0].now}`);
        testClient.release();

        client = await pool.connect();
        await client.query('BEGIN');

        await buildUsers(client);
        await buildSettings(client);
        await buildCouponCodes(client);
        await buildTasks(client);
        await buildTaskCompletions(client);
        await buildVideos(client);
        await buildVideoCompletions(client);
        await buildQuizzes(client);
        await buildQuizCompletions(client);
        await buildArticles(client);
        await buildArticleCompletions(client);
        await buildWithdrawals(client);
        await buildNotifications(client);
        await buildActivityFeed(client);
        await buildSocialLinks(client);
        await buildChatMessages(client);
        await buildChatSessions(client);
        await buildUserOnlineStatus(client);
        await buildWhatsAppPosts(client);
        await buildWhatsAppSubmissions(client);
        await buildTikTokSubmissions(client);
        await buildMarketplaceSellers(client);
        await buildTransfers(client);
        await buildPasswordResets(client);
        
        // Build Support Chat Tables
        await buildSupportTickets(client);
        await buildSupportMessages(client);

        // Build Courses Tables
        await buildCourses(client);
        await buildCourseJoins(client);

        console.log('\n🌱 Seeding database...');
        await seedAdmins(client);
        await seedCoupons(client);
        await seedSocialLinks(client);

        await client.query('COMMIT');

        console.log(`
╔═══════════════════════════════════════════════════════════╗
║           DATABASE SETUP COMPLETE! ✅                     ║
╠═══════════════════════════════════════════════════════════╣
║  📦 All tables created & auto-migrated                    ║
║  ⚡ Performance indexes added                             ║
║  🎧 Support Tickets system ready                          ║
║  📚 Courses system ready                                  ║
║  🔄 Safe to re-run anytime — data is preserved            ║
╚═══════════════════════════════════════════════════════════╝
        `);

    } catch (err) {
        if (client) {
            try { await client.query('ROLLBACK'); } catch (rbErr) { /* ignore */ }
        }
        console.error('\n❌ Setup failed:', err.message);
        process.exit(1);
    } finally {
        if (client) {
            try { client.release(); } catch (e) { /* ignore */ }
        }
        try {
            await pool.end();
            console.log('\n👋 Pool closed gracefully');
        } catch (e) {
            console.error('\n⚠️ Error closing pool:', e.message);
        }
        process.exit(0);
    }
}

if (require.main === module) {
    setupDatabase();
}

module.exports = { pool, setupDatabase };