-- Migration 020: Add missing columns to whatsapp_conversations for sellers page
-- The unified comms sellers route expects display_name, city, address, last_message, listing_id

ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS last_message TEXT;
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS listing_id INTEGER;

-- Backfill display_name from phone where NULL
UPDATE whatsapp_conversations SET display_name = phone WHERE display_name IS NULL;
