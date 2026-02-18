-- v4.24.1: Widen columns that are too narrow for enrichment data
-- The original schema had VARCHAR(100) and VARCHAR(255) limits
-- that get exceeded by Perplexity/Claude enrichment output

-- Widen to TEXT (no length limit)
ALTER TABLE complexes ALTER COLUMN neighborhood TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN region TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN developer TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN developer_strength TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN developer_status TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN developer_risk_level TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN developer_financial_health TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN price_trend TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN news_sentiment TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN signature_source TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN address TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN name TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN city TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN plan_stage TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN official_track TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN plan_number TYPE TEXT;
ALTER TABLE complexes ALTER COLUMN status TYPE TEXT;

-- Also widen buildings table
ALTER TABLE buildings ALTER COLUMN address TYPE TEXT;
ALTER TABLE buildings ALTER COLUMN street TYPE TEXT;
ALTER TABLE buildings ALTER COLUMN city TYPE TEXT;

-- Also widen listings
ALTER TABLE listings ALTER COLUMN address TYPE TEXT;
ALTER TABLE listings ALTER COLUMN city TYPE TEXT;
ALTER TABLE listings ALTER COLUMN deal_status TYPE TEXT;
ALTER TABLE listings ALTER COLUMN message_status TYPE TEXT;
