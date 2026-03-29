-- ═══════════════════════════════════════════════════════════════
-- Migration 019: Multi-Channel Outreach
-- Adds available_channels to listings + unified_messages table
-- ═══════════════════════════════════════════════════════════════

-- 1. Add available_channels to listings (computed per source)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS available_channels TEXT[] DEFAULT '{}';

-- 2. Unified messages table — all channels in one place
CREATE TABLE IF NOT EXISTS unified_messages (
  id              SERIAL PRIMARY KEY,
  listing_id      INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  complex_id      INTEGER REFERENCES complexes(id) ON DELETE SET NULL,
  contact_phone   TEXT,
  contact_name    TEXT,
  direction       TEXT NOT NULL DEFAULT 'outgoing',  -- outgoing | incoming
  channel         TEXT NOT NULL,                     -- whatsapp | yad2_chat | fb_messenger | komo_chat | sms | manual
  platform        TEXT,                              -- source platform: yad2 | facebook | komo | madlan | dira | homeless
  message_text    TEXT NOT NULL,
  external_id     TEXT,                              -- platform-specific message ID
  external_url    TEXT,                              -- link to conversation on platform
  status          TEXT DEFAULT 'pending',            -- pending | sent | delivered | read | failed | replied
  error_message   TEXT,
  metadata        JSONB DEFAULT '{}',                -- extra data per channel
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unified_messages_listing ON unified_messages(listing_id);
CREATE INDEX IF NOT EXISTS idx_unified_messages_channel ON unified_messages(channel);
CREATE INDEX IF NOT EXISTS idx_unified_messages_phone ON unified_messages(contact_phone);
CREATE INDEX IF NOT EXISTS idx_unified_messages_created ON unified_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_unified_messages_direction ON unified_messages(direction);

-- 3. Backfill available_channels based on source + phone
UPDATE listings SET available_channels =
  CASE
    WHEN source = 'yad2' AND phone IS NOT NULL AND phone != ''
      THEN ARRAY['yad2_chat', 'whatsapp']
    WHEN source = 'yad2'
      THEN ARRAY['yad2_chat']
    WHEN source = 'facebook' AND phone IS NOT NULL AND phone != ''
      THEN ARRAY['fb_messenger', 'whatsapp']
    WHEN source = 'facebook'
      THEN ARRAY['fb_messenger']
    WHEN source = 'komo' AND phone IS NOT NULL AND phone != ''
      THEN ARRAY['komo_chat', 'whatsapp']
    WHEN source = 'komo'
      THEN ARRAY['komo_chat']
    WHEN source IN ('madlan', 'dira', 'homeless') AND phone IS NOT NULL AND phone != ''
      THEN ARRAY['whatsapp']
    WHEN source IN ('madlan', 'dira', 'homeless')
      THEN ARRAY['manual']
    WHEN phone IS NOT NULL AND phone != ''
      THEN ARRAY['whatsapp']
    ELSE ARRAY['manual']
  END
WHERE available_channels = '{}' OR available_channels IS NULL;
