-- Migration 008: Extended Data Sources for Phase 4.5
-- SSI Enhancement, News Monitoring, Pricing Accuracy

-- =====================================================
-- SSI Enhancement Columns (Distressed Seller Detection)
-- =====================================================

ALTER TABLE complexes ADD COLUMN IF NOT EXISTS enhanced_ssi_score INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS ssi_enhancement_factors JSONB;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS ssi_last_enhanced TIMESTAMP WITH TIME ZONE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS has_enforcement_cases BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS has_bankruptcy_proceedings BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS has_property_liens BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS is_receivership BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS is_inheritance_property BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS distress_indicators JSONB;

-- =====================================================
-- Pricing Accuracy Columns
-- =====================================================

ALTER TABLE complexes ADD COLUMN IF NOT EXISTS accurate_price_sqm INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_confidence_score INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_trend VARCHAR(20);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS estimated_premium_price INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_last_updated TIMESTAMP WITH TIME ZONE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_sources JSONB;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS city_avg_price_sqm INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_vs_city_avg INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS cbs_price_index DECIMAL(10,2);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS yearly_price_change DECIMAL(5,2);

-- =====================================================
-- News & Regulation Columns
-- =====================================================

ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_news_check TIMESTAMP WITH TIME ZONE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS news_sentiment VARCHAR(20);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS has_negative_news BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS news_summary TEXT;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_news_sentiment VARCHAR(20);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_reputation_score INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_red_flags JSONB;

-- =====================================================
-- News Alerts Table
-- =====================================================

CREATE TABLE IF NOT EXISTS news_alerts (
  id SERIAL PRIMARY KEY,
  complex_id INTEGER REFERENCES complexes(id) ON DELETE CASCADE,
  alert_type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  source VARCHAR(100),
  source_url TEXT,
  sentiment VARCHAR(20),
  severity VARCHAR(20) DEFAULT 'medium',
  is_read BOOLEAN DEFAULT FALSE,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- Distressed Sellers Table
-- =====================================================

CREATE TABLE IF NOT EXISTS distressed_sellers (
  id SERIAL PRIMARY KEY,
  complex_id INTEGER REFERENCES complexes(id) ON DELETE CASCADE,
  owner_name VARCHAR(255),
  distress_type VARCHAR(50) NOT NULL,
  distress_score INTEGER,
  source VARCHAR(100),
  details TEXT,
  verified BOOLEAN DEFAULT FALSE,
  verified_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- Price History Table
-- =====================================================

CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  complex_id INTEGER REFERENCES complexes(id) ON DELETE CASCADE,
  city VARCHAR(100),
  price_per_sqm INTEGER NOT NULL,
  source VARCHAR(50) NOT NULL,
  confidence_score INTEGER,
  sample_size INTEGER,
  metadata JSONB,
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- Regulation Updates Table
-- =====================================================

CREATE TABLE IF NOT EXISTS regulation_updates (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  update_type VARCHAR(50) NOT NULL,
  impact VARCHAR(20),
  effective_date DATE,
  source VARCHAR(100),
  source_url TEXT,
  affected_areas JSONB,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- Indexes for Performance
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_complexes_enhanced_ssi ON complexes(enhanced_ssi_score) WHERE enhanced_ssi_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_complexes_price_trend ON complexes(price_trend) WHERE price_trend IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_complexes_news_sentiment ON complexes(news_sentiment) WHERE news_sentiment IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_complexes_has_negative_news ON complexes(has_negative_news) WHERE has_negative_news = TRUE;
CREATE INDEX IF NOT EXISTS idx_news_alerts_complex ON news_alerts(complex_id);
CREATE INDEX IF NOT EXISTS idx_news_alerts_type ON news_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_news_alerts_unread ON news_alerts(is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_distressed_sellers_complex ON distressed_sellers(complex_id);
CREATE INDEX IF NOT EXISTS idx_distressed_sellers_type ON distressed_sellers(distress_type);
CREATE INDEX IF NOT EXISTS idx_price_history_complex ON price_history(complex_id);
CREATE INDEX IF NOT EXISTS idx_price_history_city ON price_history(city);
CREATE INDEX IF NOT EXISTS idx_regulation_updates_type ON regulation_updates(update_type);
CREATE INDEX IF NOT EXISTS idx_regulation_updates_active ON regulation_updates(is_active) WHERE is_active = TRUE;

-- =====================================================
-- Comments
-- =====================================================

COMMENT ON COLUMN complexes.enhanced_ssi_score IS 'SSI score after enhancement with distress indicators';
COMMENT ON COLUMN complexes.accurate_price_sqm IS 'Multi-source validated price per sqm';
COMMENT ON COLUMN complexes.price_confidence_score IS 'Confidence in price estimate (0-100)';
COMMENT ON COLUMN complexes.developer_reputation_score IS 'Developer reputation (1-10)';
COMMENT ON TABLE news_alerts IS 'News and regulation alerts for complexes';
COMMENT ON TABLE distressed_sellers IS 'Identified distressed sellers and their indicators';
COMMENT ON TABLE price_history IS 'Historical price tracking from multiple sources';
COMMENT ON TABLE regulation_updates IS 'Regulatory changes affecting Pinuy Binuy';
