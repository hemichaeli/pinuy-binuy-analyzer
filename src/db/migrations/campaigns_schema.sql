-- ─── QUANTUM Campaigns Schema ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaigns (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'wa_then_call' CHECK (mode IN ('wa_then_call', 'call_only')),
  wa_wait_minutes INTEGER NOT NULL DEFAULT 60,   -- how long to wait for WA reply before calling
  agent_name      TEXT NOT NULL DEFAULT 'רן',
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  wa_message      TEXT,                           -- initial WA message template
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_leads (
  id              SERIAL PRIMARY KEY,
  campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,
  name            TEXT,
  source          TEXT,                          -- 'manual', 'lead_id', 'import'
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
