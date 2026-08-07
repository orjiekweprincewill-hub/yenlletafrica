INSERT INTO activity_feed (user_id, activity_type, amount) 
SELECT id, 'completed task', 50.00 
FROM users 
WHERE username = 'boys'
LIMIT 1;
