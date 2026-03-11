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

-- ========================================================
-- QUANTUM v4.75+ - Smart Slot Clustering (address-based)
-- ========================================================

ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS contact_address TEXT;
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS contact_street TEXT;
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS contact_building_no TEXT;

ALTER TABLE meeting_slots ADD COLUMN IF NOT EXISTS contact_address TEXT;
ALTER TABLE meeting_slots ADD COLUMN IF NOT EXISTS contact_street TEXT;

CREATE INDEX IF NOT EXISTS idx_meeting_slots_street ON meeting_slots(campaign_id, contact_street)
  WHERE status = 'confirmed';

-- ========================================================
-- QUANTUM v4.76+ - Schedule Optimization Engine
-- ========================================================

CREATE TABLE IF NOT EXISTS reschedule_requests (
  id                    SERIAL PRIMARY KEY,
  original_slot_id      INTEGER NOT NULL REFERENCES meeting_slots(id),
  campaign_id           TEXT NOT NULL,
  phone                 VARCHAR(30) NOT NULL,
  zoho_contact_id       TEXT,
  contact_name          TEXT,
  language              TEXT DEFAULT 'he',
  original_datetime     TIMESTAMPTZ NOT NULL,
  proposed_slot_id      INTEGER NOT NULL REFERENCES meeting_slots(id),
  proposed_datetime     TIMESTAMPTZ NOT NULL,
  gap_saved_minutes     INTEGER,
  cluster_gain          INTEGER,
  status                TEXT NOT NULL DEFAULT 'pending',
  wa_sent_at            TIMESTAMPTZ,
  wa_replied_at         TIMESTAMPTZ,
  call_triggered_at     TIMESTAMPTZ,
  call_completed_at     TIMESTAMPTZ,
  swapped_at            TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(original_slot_id)
);

CREATE INDEX IF NOT EXISTS idx_reschedule_status   ON reschedule_requests(status);
CREATE INDEX IF NOT EXISTS idx_reschedule_phone    ON reschedule_requests(phone);
CREATE INDEX IF NOT EXISTS idx_reschedule_campaign ON reschedule_requests(campaign_id);
CREATE INDEX IF NOT EXISTS idx_reschedule_expires  ON reschedule_requests(expires_at) WHERE status = 'pending';

-- ========================================================
-- QUANTUM v4.79+ - Campaign Availability Settings
-- ========================================================

ALTER TABLE campaign_schedule_config
  ADD COLUMN IF NOT EXISTS default_start_time TIME DEFAULT '09:00:00';

ALTER TABLE campaign_schedule_config
  ADD COLUMN IF NOT EXISTS default_end_time TIME DEFAULT '18:00:00';

UPDATE campaign_schedule_config
  SET available_windows = '[
    {"day":0,"start":"09:00","end":"18:00"},
    {"day":1,"start":"09:00","end":"18:00"},
    {"day":2,"start":"09:00","end":"18:00"},
    {"day":3,"start":"09:00","end":"18:00"},
    {"day":4,"start":"09:00","end":"18:00"}
  ]'::jsonb
  WHERE available_windows = '[]'::jsonb OR available_windows IS NULL;

-- ========================================================
-- QUANTUM v4.81+ - Zoho Calendar event IDs
-- ========================================================

ALTER TABLE meeting_slots ADD COLUMN IF NOT EXISTS zoho_event_id TEXT;
ALTER TABLE ceremony_slots ADD COLUMN IF NOT EXISTS zoho_event_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS zoho_calendar_id TEXT;
ALTER TABLE ceremony_stations ADD COLUMN IF NOT EXISTS zoho_calendar_id TEXT;

-- ========================================================
-- QUANTUM v4.89+ - Per-project INFORU credentials
-- ========================================================

ALTER TABLE projects ADD COLUMN IF NOT EXISTS inforu_username TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS inforu_password TEXT;

-- ========================================================
-- QUANTUM v4.90+ - Professional Visits (Appraiser / Surveyor)
-- ========================================================

CREATE TABLE IF NOT EXISTS professional_visits (
  id                    SERIAL PRIMARY KEY,
  campaign_id           TEXT NOT NULL,
  project_id            INTEGER REFERENCES projects(id),
  visit_type            TEXT NOT NULL CHECK (visit_type IN ('appraiser','surveyor')),
  building_address      TEXT NOT NULL,
  city                  TEXT NOT NULL,
  visit_date            DATE NOT NULL,
  start_time            TIME NOT NULL,
  end_time              TIME NOT NULL,
  slot_duration_minutes INTEGER NOT NULL DEFAULT 30,
  buffer_minutes        INTEGER NOT NULL DEFAULT 5,
  status                TEXT NOT NULL DEFAULT 'active',
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prof_visits_campaign ON professional_visits(campaign_id);
CREATE INDEX IF NOT EXISTS idx_prof_visits_building ON professional_visits(building_address, visit_date);

CREATE TABLE IF NOT EXISTS visit_professionals (
  id                    SERIAL PRIMARY KEY,
  visit_id              INTEGER NOT NULL REFERENCES professional_visits(id) ON DELETE CASCADE,
  professional_name     TEXT NOT NULL,
  professional_phone    TEXT,
  zoho_calendar_id      TEXT,
  display_order         INTEGER DEFAULT 0,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visit_professionals_visit ON visit_professionals(visit_id);

ALTER TABLE meeting_slots ADD COLUMN IF NOT EXISTS visit_professional_id INTEGER REFERENCES visit_professionals(id);
ALTER TABLE meeting_slots ADD COLUMN IF NOT EXISTS apartment_number TEXT;

CREATE INDEX IF NOT EXISTS idx_meeting_slots_visit_prof ON meeting_slots(visit_professional_id)
  WHERE visit_professional_id IS NOT NULL;

ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS building_address TEXT;
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS apartment_number TEXT;
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS campaign_buildings JSONB DEFAULT '[]';
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS campaign_end_date DATE;
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS campaign_status TEXT DEFAULT 'Active';

CREATE INDEX IF NOT EXISTS idx_bot_sessions_building_addr ON bot_sessions(building_address)
  WHERE building_address IS NOT NULL;

-- ========================================================
-- QUANTUM v4.92+ - Outreach Campaigns (WA→Call / Call-Only)
-- ========================================================

CREATE TABLE IF NOT EXISTS campaigns (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'wa_then_call' CHECK (mode IN ('wa_then_call', 'call_only')),
  wa_wait_minutes INTEGER NOT NULL DEFAULT 60,
  agent_name      TEXT NOT NULL DEFAULT 'רן',
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  wa_message      TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_leads (
  id                  SERIAL PRIMARY KEY,
  campaign_id         INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  phone               TEXT NOT NULL,
  name                TEXT,
  source              TEXT,
  lead_id             INTEGER REFERENCES leads(id),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','wa_sent','wa_replied','call_queued','call_initiated','call_done','failed','opted_out')),
  wa_sent_at          TIMESTAMPTZ,
  wa_replied_at       TIMESTAMPTZ,
  call_queued_at      TIMESTAMPTZ,
  call_initiated_at   TIMESTAMPTZ,
  vapi_call_id        TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign ON campaign_leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_status    ON campaign_leads(status);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_wa_sent   ON campaign_leads(wa_sent_at) WHERE status = 'wa_sent';

-- ========================================================
-- QUANTUM v4.93+ - System Settings (WA Bot Escalation)
-- ========================================================

CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  label      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO system_settings (key, value, label)
VALUES ('wa_bot_escalation_minutes', '60', 'ז