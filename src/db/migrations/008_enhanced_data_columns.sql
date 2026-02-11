-- Migration 008: Enhanced data columns alignment
-- Adds missing columns for Phase 4.5 enhanced data routes

-- Madlan columns
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS madlan_last_updated TIMESTAMP;

-- Official verification columns  
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS is_officially_declared BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_track VARCHAR(100);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_declaration_date DATE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_plan_number VARCHAR(100);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_certainty_score INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_last_verified TIMESTAMP;

-- Committee tracking columns
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_trigger_detected BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_committee_decision TEXT;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_committee_date DATE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_trigger_impact VARCHAR(50);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS committee_last_checked TIMESTAMP;

-- Developer verification columns
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_company_number VARCHAR(50);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_status VARCHAR(100);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_risk_score INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_risk_level VARCHAR(50);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_last_verified TIMESTAMP;

-- Indexes for new columns
CREATE INDEX IF NOT EXISTS idx_complexes_official_declared ON complexes(is_officially_declared);
CREATE INDEX IF NOT EXISTS idx_complexes_price_trigger ON complexes(price_trigger_detected);
CREATE INDEX IF NOT EXISTS idx_complexes_developer_risk ON complexes(developer_risk_score);
CREATE INDEX IF NOT EXISTS idx_complexes_madlan_updated ON complexes(madlan_last_updated);
