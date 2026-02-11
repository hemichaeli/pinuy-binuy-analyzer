-- Migration: Add discovery support columns
-- Date: 2026-02-11

-- Add discovery_source column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'complexes' AND column_name = 'discovery_source') THEN
        ALTER TABLE complexes ADD COLUMN discovery_source VARCHAR(50);
    END IF;
END $$;

-- Make slug column nullable to allow incremental migration
-- (New code will generate slugs, but old records may not have them)
ALTER TABLE complexes ALTER COLUMN slug DROP NOT NULL;

-- Generate slugs for any records that don't have them
UPDATE complexes 
SET slug = LOWER(
    REGEXP_REPLACE(
        REGEXP_REPLACE(city, '[^a-zA-Z0-9\u0590-\u05FF]', '', 'g'),
        '[\u0590-\u05FF]', 
        '', 
        'g'
    ) || '-' || 
    id::text || '-' || 
    EXTRACT(EPOCH FROM NOW())::int::text
)
WHERE slug IS NULL OR slug = '';

-- Add index for discovery queries
CREATE INDEX IF NOT EXISTS idx_complexes_discovery_source ON complexes(discovery_source);

-- Log success
DO $$ 
BEGIN
    RAISE NOTICE 'Discovery migration completed successfully';
END $$;
