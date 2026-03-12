-- Migration 009: Listing enrichment columns (Gemini + Perplexity)
-- Adds AI enrichment fields to the listings table

-- Add missing columns first
ALTER TABLE listings ADD COLUMN IF NOT EXISTS title VARCHAR(500);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS contact_name VARCHAR(200);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS phone VARCHAR(30);

-- Remove duplicate (source, source_listing_id) rows before creating unique index
-- Keep the row with the highest id (most recent) for each duplicate group
DELETE FROM listings
WHERE id NOT IN (
  SELECT MAX(id)
  FROM listings
  WHERE source_listing_id IS NOT NULL
  GROUP BY source, source_listing_id
)
AND source_listing_id IS NOT NULL;

-- Now create unique index safely
CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_source_id ON listings(source, source_listing_id) WHERE source_listing_id IS NOT NULL;

-- Gemini enrichment columns
ALTER TABLE listings ADD COLUMN IF NOT EXISTS gemini_urgency_flag TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS gemini_urgency_reason TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS gemini_hidden_info TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS exact_address_enriched TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS gemini_score_boost INTEGER DEFAULT 0;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS gemini_score_reason TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS gemini_enriched_at TIMESTAMPTZ;

-- Perplexity enrichment columns
ALTER TABLE listings ADD COLUMN IF NOT EXISTS building_year INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS building_age INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS nearby_plans JSONB;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS has_renewal_plan BOOLEAN DEFAULT FALSE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS recent_transactions JSONB;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS avg_price_sqm_area INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_motivation_score INTEGER DEFAULT 0;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_motivation_reason TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_vs_market TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_discount_pct DECIMAL(5,2);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS perplexity_public_notes TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS perplexity_enriched_at TIMESTAMPTZ;

-- Indexes for enrichment queries
CREATE INDEX IF NOT EXISTS idx_listings_gemini_enriched ON listings(gemini_enriched_at) WHERE gemini_enriched_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_listings_seller_motivation ON listings(seller_motivation_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_listings_urgency_flag ON listings(gemini_urgency_flag) WHERE gemini_urgency_flag IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_has_renewal ON listings(has_renewal_plan) WHERE has_renewal_plan = TRUE;
