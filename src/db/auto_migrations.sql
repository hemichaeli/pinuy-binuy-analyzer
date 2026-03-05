-- QUANTUM Auto Migrations
-- Runs on every startup via runAutoMigrations()

-- vapi_calls table for QUANTUM Voice AI
CREATE TABLE IF NOT EXISTS vapi_calls (
  id              SERIAL PRIMARY KEY,
  call_id         TEXT UNIQUE NOT NULL,
  phone           TEXT NOT NULL,
  agent_type      TEXT NOT NULL DEFAULT 'unknown',
  lead_id         INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  complex_id      INTEGER REFERENCES complexes(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'initiated',
  duration_seconds INTEGER,
  summary         TEXT,
  intent          TEXT,
  transcript      JSONB,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vapi_calls_phone     ON vapi_calls(phone);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_lead_id   ON vapi_calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_agent     ON vapi_calls(agent_type);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_intent    ON vapi_calls(intent);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_created   ON vapi_calls(created_at DESC);
