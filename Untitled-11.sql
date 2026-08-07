-- Add a column to enable/disable ads site-wide
ALTER TABLE settings ADD COLUMN IF NOT EXISTS google_ads_enabled BOOLEAN DEFAULT true;

-- Initialize it to true (or false if you want them off by default)
UPDATE settings SET google_ads_enabled = true WHERE id = 1;
