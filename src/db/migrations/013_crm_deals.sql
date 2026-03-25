-- Migration 013: CRM Deals table
-- Creates the deals table for CRM pipeline management

CREATE TABLE IF NOT EXISTS deals (
  id              SERIAL PRIMARY KEY,
  lead_id         INTEGER,
  complex_id      INTEGER,
  title           TEXT NOT NULL,
  value           NUMERIC(12,2) DEFAULT 0,
  stage           TEXT NOT NULL DEFAULT 'prospect'
                    CHECK (stage IN ('prospect','qualified','proposal','negotiation','won','lost')),
  notes           TEXT DEFAULT '',
  expected_close  DATE,
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deals_lead_id    ON deals(lead_id);
CREATE INDEX IF NOT EXISTS idx_deals_complex_id ON deals(complex_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage      ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_updated_at ON deals(updated_at DESC);

-- Seed demo deals (no FK dependency)
INSERT INTO deals (title, value, stage, notes)
SELECT unnest(ARRAY['פרויקט תל אביב — מגדל A','פרויקט רמת גן — בניין 3','פרויקט חיפה — מתחם הנמל']),
       unnest(ARRAY[2500000::numeric, 1800000::numeric, 3200000::numeric]),
       unnest(ARRAY['prospect','qualified','proposal']),
       unnest(ARRAY['ליד ממערכת QUANTUM','בשלב בדיקת היתכנות','הצעה נשלחה ללקוח'])
WHERE NOT EXISTS (SELECT 1 FROM deals LIMIT 1);
