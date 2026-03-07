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

-- Which building this session's contact belongs to (for ceremony routing)
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS ceremony_building_id INTEGER REFERENCES ceremony_buildings(id);

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_bot_sessions_building ON bot_sessions(ceremony_building_id);

-- Store contact's building label in context (denormalized for display)
-- Note: actual assignment is in ceremony_building_id column above.
-- The broadcast endpoint (or /ceremony/:id/assign) sets this before sending WA.
