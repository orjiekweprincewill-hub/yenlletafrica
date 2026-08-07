-- Set you as Super Admin
UPDATE users SET role = 'superadmin', is_admin = true WHERE username = 'admin';

-- Set your helper as Assistant
UPDATE users SET role = 'assistant', is_admin = true WHERE username = 'helper_admin';

-- VERIFY: Run this to see if it actually changed
SELECT username, role, is_admin FROM users WHERE username IN ('admin', 'helper_admin');
