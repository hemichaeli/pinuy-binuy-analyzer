-- Phase 4.2 Migration: Add yad2 scan tracking

-- Add last_yad2_scan column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'complexes' AND column_name = 'last_yad2_scan') THEN
        ALTER TABLE complexes ADD COLUMN last_yad2_scan TIMESTAMP;
    END IF;
END $$;

-- Create index for stale yad2 scans
CREATE INDEX IF NOT EXISTS idx_complexes_yad2_scan 
ON complexes(last_yad2_scan) WHERE last_yad2_scan IS NOT NULL;

-- Add index for price drop alerts
CREATE INDEX IF NOT EXISTS idx_alerts_price_drop 
ON alerts(alert_type, created_at DESC) WHERE alert_type = 'price_drop';

-- Add index for listing price tracking
CREATE INDEX IF NOT EXISTS idx_listings_price_tracking 
ON listings(complex_id, is_active, original_price, asking_price) 
WHERE is_active = TRUE;
