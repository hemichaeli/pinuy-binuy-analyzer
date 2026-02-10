-- Phase 4.1 Migration: Add national committee tracking and planning notes

-- Add national_committee_date column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'complexes' AND column_name = 'national_committee_date') THEN
        ALTER TABLE complexes ADD COLUMN national_committee_date DATE;
    END IF;
END $$;

-- Add planning_notes column for upcoming hearings
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'complexes' AND column_name = 'planning_notes') THEN
        ALTER TABLE complexes ADD COLUMN planning_notes TEXT;
    END IF;
END $$;

-- Add last_mavat_update if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'complexes' AND column_name = 'last_mavat_update') THEN
        ALTER TABLE complexes ADD COLUMN last_mavat_update TIMESTAMP;
    END IF;
END $$;

-- Add last_committee_scan timestamp
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'complexes' AND column_name = 'last_committee_scan') THEN
        ALTER TABLE complexes ADD COLUMN last_committee_scan TIMESTAMP;
    END IF;
END $$;

-- Create index for committee tracking queries
CREATE INDEX IF NOT EXISTS idx_complexes_committee_status 
ON complexes(status, local_committee_date, district_committee_date);

-- Create index for stale committee scans
CREATE INDEX IF NOT EXISTS idx_complexes_committee_scan 
ON complexes(last_committee_scan) WHERE status IN ('planning', 'pre_deposit', 'deposited', 'approved');
