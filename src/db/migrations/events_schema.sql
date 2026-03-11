-- QUANTUM Event Scheduler — DB Schema v1.1
-- Fix: use md5+random instead of gen_random_bytes (no pgcrypto required)

CREATE TABLE IF NOT EXISTS quantum_events (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  event_type      TEXT NOT NULL DEFAULT 'signing',  -- signing | survey | appraisal | other
  event_date      TIMESTAMPTZ NOT NULL,
  location        TEXT,
  zoho_compound_id TEXT,
  compound_name   TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',    -- draft | active | completed | cancelled
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_stations (
  id              SERIAL PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES quantum_events(id) ON DELETE CASCADE,
  pro_name        TEXT NOT NULL,
  pro_role        TEXT NOT NULL DEFAULT 'lawyer',   -- lawyer | surveyor | appraiser | other
  pro_phone       TEXT,
  pro_email       TEXT,
  station_number  INTEGER,
  token           TEXT NOT NULL UNIQUE DEFAULT md5(random()::text || clock_timestamp()::text),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_slots (
  id              SERIAL PRIMARY KEY,
  station_id      INTEGER NOT NULL REFERENCES event_stations(id) ON DELETE CASCADE,
  start_time      TIMESTAMPTZ NOT NULL,
  end_time        TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'free',     -- free | booked | blocked
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_attendees (
  id              SERIAL PRIMARY KEY,
  station_id      INTEGER NOT NULL REFERENCES event_stations(id) ON DELETE CASCADE,
  slot_id         INTEGER REFERENCES event_slots(id) ON DELETE SET NULL,
  zoho_contact_id TEXT,
  zoho_asset_id   TEXT,
  name            TEXT NOT NULL,
  phone           TEXT,
  unit_number     TEXT,
  floor           TEXT,
  building_name   TEXT,
  compound_name   TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | cancelled | rescheduled | arrived | no_show
  token           TEXT NOT NULL UNIQUE DEFAULT md5(random()::text || clock_timestamp()::text || random()::text),
  notes           TEXT,
  pro_notes       TEXT,
  wa_sent_at      TIMESTAMPTZ,
  email_sent_at   TIMESTAMPTZ,
  responded_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_stations_event    ON event_stations(event_id);
CREATE INDEX IF NOT EXISTS idx_event_slots_station     ON event_slots(station_id);
CREATE INDEX IF NOT EXISTS idx_event_attendees_station ON event_attendees(station_id);
CREATE INDEX IF NOT EXISTS idx_event_attendees_token   ON event_attendees(token);
CREATE INDEX IF NOT EXISTS idx_event_stations_token    ON event_stations(token);
CREATE INDEX IF NOT EXISTS idx_quantum_events_date     ON quantum_events(event_date);
