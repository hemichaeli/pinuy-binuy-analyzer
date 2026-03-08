-- Migration 008: Appointments Scheduling Bot Tables
-- Creates appointments and appointment_slots tables for the Zoho Webhook → WhatsApp → Vapi flow

CREATE TABLE IF NOT EXISTS appointment_slots (
  id SERIAL PRIMARY KEY,
  building_id VARCHAR(100) NOT NULL,
  campaign_type VARCHAR(50) NOT NULL,  -- signing_event | surveyor | appraiser | signing_meeting
  slot_datetime TIMESTAMP NOT NULL,
  max_capacity INTEGER DEFAULT 1,
  booked_count INTEGER DEFAULT 0,
  is_available BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT chk_booked_count CHECK (booked_count >= 0 AND booked_count <= max_capacity)
);

CREATE INDEX IF NOT EXISTS idx_appointment_slots_building_type
  ON appointment_slots (building_id, campaign_type, is_available);

CREATE INDEX IF NOT EXISTS idx_appointment_slots_datetime
  ON appointment_slots (slot_datetime);

CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  contact_id VARCHAR(100),
  phone VARCHAR(20) NOT NULL,
  building_id VARCHAR(100),
  campaign_type VARCHAR(50),           -- signing_event | surveyor | appraiser | signing_meeting
  appointment_date TIMESTAMP,
  slot_id INTEGER REFERENCES appointment_slots(id),
  status VARCHAR(20) DEFAULT 'pending', -- pending | confirmed | cancelled | no_answer
  whatsapp_sent_at TIMESTAMP,
  vapi_called_at TIMESTAMP,
  confirmed_at TIMESTAMP,
  zoho_updated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_phone
  ON appointments (phone);

CREATE INDEX IF NOT EXISTS idx_appointments_status
  ON appointments (status);

CREATE INDEX IF NOT EXISTS idx_appointments_building
  ON appointments (building_id, campaign_type);

CREATE INDEX IF NOT EXISTS idx_appointments_pending_fallback
  ON appointments (whatsapp_sent_at, status, vapi_called_at)
  WHERE status = 'pending' AND vapi_called_at IS NULL;
