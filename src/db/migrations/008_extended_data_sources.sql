-- Migration 008: Extended Data Sources for Phase 4.5
-- SSI Enhancement, Pricing Accuracy, News & Regulation Monitoring

-- SSI Enhancement columns
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS enhanced_ssi_score INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS ssi_enhancement_factors JSONB;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS ssi_last_enhanced TIMESTAMP;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS has_enforcement_cases BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS has_bankruptcy_proceedings BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS has_property_liens BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS is_receivership BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS is_inheritance_property BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS distress_indicators JSONB;

-- Pricing Accuracy columns
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS accurate_price_sqm INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_confidence_score INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_trend VARCHAR(20);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS estimated_premium_price INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_last_updated TIMESTAMP;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_sources JSONB;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS city_avg_price_sqm INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS price_vs_city_avg DECIMAL(5,2);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS cbs_price_index DECIMAL(8,2);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS yearly_price_change DECIMAL(5,2);

-- News & Regulation columns
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_news_check TIMESTAMP;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS news_sentiment VARCHAR(20);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS has_negative_news BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS news_summary TEXT;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_news_sentiment VARCHAR(20);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_reputation_score INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_red_flags JSONB;

-- News Alerts table
CREATE TABLE IF NOT EXISTS news_alerts (
    id SERIAL PRIMARY KEY,
    complex_id INTEGER REFERENCES complexes(id) ON DELETE CASCADE,
    alert_type VARCHAR(50) NOT NULL,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    source VARCHAR(100),
    source_url TEXT,
    sentiment VARCHAR(20),
    severity VARCHAR(20) DEFAULT 'medium',
    is_read BOOLEAN DEFAULT FALSE,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Distressed Sellers table
CREATE TABLE IF NOT EXISTS distressed_sellers (
    id SERIAL PRIMARY KEY,
    complex_id INTEGER REFERENCES complexes(id) ON DELETE CASCADE,
    owner_name VARCHAR(200),
    distress_type VARCHAR(50) NOT NULL,
    distress_score INTEGER,
    source VARCHAR(100),
    details JSONB,
    verified BOOLEAN DEFAULT FALSE,
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Price History table
CREATE TABLE IF NOT EXISTS price_history (
    id SERIAL PRIMARY KEY,
    complex_id INTEGER REFERENCES complexes(id) ON DELETE CASCADE,
    city VARCHAR(100),
    price_per_sqm INTEGER,
    source VARCHAR(50),
    confidence_score INTEGER,
    sample_size INTEGER,
    metadata JSONB,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Regulation Updates table
CREATE TABLE IF NOT EXISTS regulation_updates (
    id SERIAL PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    update_type VARCHAR(50),
    impact VARCHAR(20),
    effective_date DATE,
    source VARCHAR(200),
    source_url TEXT,
    affected_areas JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_complexes_enhanced_ssi ON complexes(enhanced_ssi_score);
CREATE INDEX IF NOT EXISTS idx_complexes_price_confidence ON complexes(price_confidence_score);
CREATE INDEX IF NOT EXISTS idx_complexes_has_negative_news ON complexes(has_negative_news);
CREATE INDEX IF NOT EXISTS idx_news_alerts_complex ON news_alerts(complex_id);
CREATE INDEX IF NOT EXISTS idx_news_alerts_type ON news_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_news_alerts_created ON news_alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_distressed_sellers_complex ON distressed_sellers(complex_id);
CREATE INDEX IF NOT EXISTS idx_distressed_sellers_type ON distressed_sellers(distress_type);
CREATE INDEX IF NOT EXISTS idx_price_history_complex ON price_history(complex_id);
CREATE INDEX IF NOT EXISTS idx_price_history_city ON price_history(city);
CREATE INDEX IF NOT EXISTS idx_regulation_updates_type ON regulation_updates(update_type);
