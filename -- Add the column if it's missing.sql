-- Add the column if it's missing
ALTER TABLE settings ADD COLUMN IF NOT EXISTS google_ads_enabled BOOLEAN DEFAULT true;

-- Ensure a row exists to update
INSERT INTO settings (id, google_ads_enabled) VALUES (1, true) 
ON CONFLICT (id) DO NOTHING;
