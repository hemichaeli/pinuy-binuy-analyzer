-- Discovery feature migration
-- Adds columns for tracking discovered complexes

-- Add discovery_source column to track how complex was added
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS discovery_source VARCHAR(50) DEFAULT NULL;

-- Add index for faster queries on discovered complexes
CREATE INDEX IF NOT EXISTS idx_complexes_discovery_source ON complexes(discovery_source) WHERE discovery_source IS NOT NULL;

-- Add plan_number column for mavat tracking
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS plan_number VARCHAR(50) DEFAULT NULL;

-- Add alert type for new complex discoveries
-- (alerts table already has alert_type column)
