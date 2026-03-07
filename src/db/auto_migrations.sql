-- ========================================================
-- QUANTUM v4.64+ - Visual Booking System
-- ========================================================

ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS booking_token TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_bot_sessions_booking_token ON bot_sessions(booking_token);
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS booking_completed_at TIMESTAMPTZ;

ALTER TABLE campaign_schedule_config ADD COLUMN IF NOT EXISTS show_rep_name BOOLEAN DEFAULT true;
ALTER TABLE campaign_schedule_config ADD COLUMN IF NOT EXISTS show_station_number BOOLEAN DEFAULT false;
ALTER TABLE campaign_schedule_config ADD COLUMN IF NOT EXISTS booking_link_expires_hours INTEGER DEFAULT 48;
ALTER TABLE campaign_schedule_config ADD COLUMN IF NOT EXISTS slot_fill_strategy TEXT DEFAULT 'sequential';

ALTER TABLE meeting_slots ADD COLUMN IF NOT EXISTS contact_name TEXT;

-- ========================================================
-- QUANTUM v4.66+ - Ceremony Building Assignment
-- ========================================================

ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS ceremony_building_id INTEGER REFERENCES ceremony_buildings(id);
CREATE INDEX IF NOT EXISTS idx_bot_sessions_building ON bot_sessions(ceremony_building_id);

-- ========================================================
-- QUANTUM v4.67+ - Kones Contact Columns (Issue #5)
-- ========================================================

ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS contact_status VARCHAR(30) DEFAULT NULL;
ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS contact_attempts INTEGER DEFAULT 0;
ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMP;
ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS price NUMERIC(15,0);
ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS source_site VARCHAR(50) DEFAULT 'konesisrael';

CREATE INDEX IF NOT EXISTS idx_kones_contact_status ON kones_listings(contact_status) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_kones_phone ON kones_listings(phone) WHERE phone IS NOT NULL;

-- kones2.co.il listings table (P1 scraper)
CREATE TABLE IF NOT EXISTS kones2_listings (
  id SERIAL PRIMARY KEY,
  external_id VARCHAR(100),
  address TEXT,
  city VARCHAR(100),
  property_type VARCHAR(50),
  price NUMERIC(15,0),
  phone VARCHAR(30),
  contact_name VARCHAR(200),
  contact_status VARCHAR(30) DEFAULT NULL,
  contact_attempts INTEGER DEFAULT 0,
  last_contact_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  raw_data JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(external_id)
);
CREATE INDEX IF NOT EXISTS idx_kones2_contact ON kones2_listings(contact_status) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_kones2_phone ON kones2_listings(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kones2_city ON kones2_listings(city);

-- konesonline.co.il listings table (P1 scraper)
CREATE TABLE IF NOT EXISTS konesonline_listings (
  id SERIAL PRIMARY KEY,
  external_id VARCHAR(100),
  address TEXT,
  city VARCHAR(100),
  property_type VARCHAR(50),
  price NUMERIC(15,0),
  phone VARCHAR(30),
  contact_name VARCHAR(200),
  contact_status VARCHAR(30) DEFAULT NULL,
  contact_attempts INTEGER DEFAULT 0,
  last_contact_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  raw_data JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(external_id)
);
CREATE INDEX IF NOT EXISTS idx_konesonline_contact ON konesonline_listings(contact_status) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_konesonline_phone ON konesonline_listings(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_konesonline_city ON konesonline_listings(city);
