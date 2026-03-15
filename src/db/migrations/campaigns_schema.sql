-- ─── QUANTUM Campaigns Schema ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaigns (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'wa_then_call' CHECK (mode IN ('wa_then_call', 'call_only')),
  wa_wait_minutes INTEGER NOT NULL DEFAULT 60,
  agent_name      TEXT NOT NULL DEFAULT 'רן',
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  wa_message      TEXT,
  notes           TEXT,
  -- v2: voice & script settings
  voice_gender    TEXT NOT NULL DEFAULT 'male' CHECK (voice_gender IN ('male', 'female')),
  voice_name      TEXT,                          -- e.g. 'oren', 'rachel', custom Vapi voice ID
  voice_provider  TEXT NOT NULL DEFAULT 'vapi'  CHECK (voice_provider IN ('vapi', 'elevenlabs', 'azure')),
  call_script     TEXT,                          -- full call script / system prompt override
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add columns if upgrading from earlier schema
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS voice_gender   TEXT NOT NULL DEFAULT 'male';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS voice_name     TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS voice_provider TEXT NOT NULL DEFAULT 'vapi';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS call_script    TEXT;

CREATE TABLE IF NOT EXISTS campaign_leads (
  id              SERIAL PRIMARY KEY,
  campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,
  name            TEXT,
  source          TEXT,
  lead_id         INTEGER REFERENCES leads(id),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','wa_sent','wa_replied','call_queued','call_initiated','call_done','failed','opted_out')),
  wa_sent_at      TIMESTAMPTZ,
  wa_replied_at   TIMESTAMPTZ,
  call_queued_at  TIMESTAMPTZ,
  call_initiated_at TIMESTAMPTZ,
  vapi_call_id    TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign ON campaign_leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_status    ON campaign_leads(status);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_wa_sent   ON campaign_leads(wa_sent_at) WHERE status = 'wa_sent';
CREATE INDEX IF NOT EXISTS idx_campaign_leads_lead_id   ON campaign_leads(lead_id) WHERE lead_id IS NOT NULL;
-- ========================================================
-- QUANTUM v5.0 - Campaign Flow Engine
-- Adds: flow control settings, template IDs, reminder/call tracking
-- ========================================================

-- ── campaigns: add flow control columns ──────────────────
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS zoho_campaign_id     TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS max_wa_reminders     INTEGER NOT NULL DEFAULT 2;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS wa_reminder_delay_hours INTEGER NOT NULL DEFAULT 24;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS reminder1_template_id TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS reminder2_template_id TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS max_call_attempts    INTEGER NOT NULL DEFAULT 2;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS call_delay_after_wa_hours INTEGER NOT NULL DEFAULT 48;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS call_retry_delay_hours    INTEGER NOT NULL DEFAULT 24;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS flow_enabled              BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS initial_message_inforu_id TEXT; -- INFORU template ID of the Zoho-sent initial message (read-only reference)

-- ── campaign_leads: add flow tracking columns ────────────
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS zoho_contact_id      TEXT;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS flow_stage           TEXT NOT NULL DEFAULT 'initial'
  CHECK (flow_stage IN (
    'initial',          -- Zoho sent initial message, waiting for reply
    'reminder_1_sent',  -- First WA reminder sent
    'reminder_2_sent',  -- Second WA reminder sent
    'call_1_initiated', -- First Vapi call placed
    'call_1_no_answer', -- First call: no answer
    'call_2_initiated', -- Second Vapi call placed
    'call_2_no_answer', -- Second call: no answer
    'replied',          -- Lead replied to WA (any stage)
    'call_answered',    -- Lead answered a call
    'converted',        -- Meeting booked / deal progressing
    'opted_out',        -- Requested removal
    'exhausted',        -- All attempts done, no response
    'failed'            -- Technical failure
  ));
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS reminder_count       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS call_attempt_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS reminder1_sent_at    TIMESTAMPTZ;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS reminder2_sent_at    TIMESTAMPTZ;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS call1_initiated_at   TIMESTAMPTZ;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS call1_vapi_id        TEXT;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS call2_initiated_at   TIMESTAMPTZ;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS call2_vapi_id        TEXT;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS last_activity_at     TIMESTAMPTZ;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS zoho_last_synced_at  TIMESTAMPTZ;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS city                 TEXT;

-- ── campaign_flow_log: full audit trail ──────────────────
CREATE TABLE IF NOT EXISTS campaign_flow_log (
  id              SERIAL PRIMARY KEY,
  campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id         INTEGER NOT NULL REFERENCES campaign_leads(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,
  action          TEXT NOT NULL,
  -- 'wa_reminder_1', 'wa_reminder_2', 'call_1', 'call_2',
  -- 'wa_replied', 'call_answered', 'opted_out', 'zoho_sync', 'error'
  stage_before    TEXT,
  stage_after     TEXT,
  success         BOOLEAN NOT NULL DEFAULT TRUE,
  details         JSONB,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_flow_log_campaign ON campaign_flow_log(campaign_id);
CREATE INDEX IF NOT EXISTS idx_flow_log_lead     ON campaign_flow_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_flow_log_created  ON campaign_flow_log(created_at DESC);

-- ── indexes for flow engine queries ──────────────────────
CREATE INDEX IF NOT EXISTS idx_cl_flow_stage    ON campaign_leads(flow_stage);
CREATE INDEX IF NOT EXISTS idx_cl_reminder1_at  ON campaign_leads(reminder1_sent_at) WHERE reminder1_sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cl_reminder2_at  ON campaign_leads(reminder2_sent_at) WHERE reminder2_sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cl_call1_at      ON campaign_leads(call1_initiated_at) WHERE call1_initiated_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cl_zoho_contact  ON campaign_leads(zoho_contact_id) WHERE zoho_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaigns_zoho   ON campaigns(zoho_campaign_id) WHERE zoho_campaign_id IS NOT NULL;
