-- Migration: Add mavat/committee tracking columns to complexes
-- Run this to add planning authority tracking fields

-- Committee tracking dates
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS local_committee_date DATE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS district_committee_date DATE;

-- mavat scan tracking
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_mavat_update TIMESTAMP;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS planning_notes TEXT;

-- Index for mavat scanning priority
CREATE INDEX IF NOT EXISTS idx_complexes_mavat_update ON complexes(last_mavat_update ASC NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_complexes_committee ON complexes(local_committee_date, district_committee_date);
