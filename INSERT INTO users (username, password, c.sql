INSERT INTO users (username, password, coupon_code, plan, is_banned) 
VALUES ('admin', 'admin123', 'ADMIN-001', 'YENVITE', false)
ON CONFLICT (username) DO NOTHING;
