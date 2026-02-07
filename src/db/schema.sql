-- Pinuy Binuy Investment Analyzer - Database Schema
-- Based on methodology document v1.0

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- Table: complexes (מתחמים)
-- ============================================
CREATE TABLE IF NOT EXISTS complexes (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    city VARCHAR(100) NOT NULL,
    region VARCHAR(100),
    neighborhood VARCHAR(100),
    addresses TEXT,
    
    -- Planning data (נתונים תכנוניים)
    plan_number VARCHAR(50),
    status VARCHAR(50) NOT NULL DEFAULT 'unknown',
    -- Statuses: deposited(הופקדה), approved(אושרה), pre_deposit(להפקדה), 
    --           planning(בתכנון), construction(בביצוע), declared(הוכרז)
    declaration_date DATE,
    submission_date DATE,
    deposit_date DATE,
    approval_date DATE,
    permit_date DATE,
    
    -- Scope (היקף)
    num_buildings INT,
    existing_units INT,
    planned_units INT,
    multiplier DECIMAL(4,2),
    area_dunam DECIMAL(8,2),
    
    -- Developer (יזם)
    developer VARCHAR(255),
    developer_strength VARCHAR(20) DEFAULT 'unknown',
    -- Values: strong, medium, weak, unknown
    signature_percent INT,
    
    -- Calculated fields (שדות מחושבים)
    theoretical_premium_min DECIMAL(5,2),
    theoretical_premium_max DECIMAL(5,2),
    actual_premium DECIMAL(5,2),
    premium_gap DECIMAL(5,2),
    iai_score INT DEFAULT 0,
    certainty_factor DECIMAL(4,2) DEFAULT 1.0,
    yield_factor DECIMAL(4,2) DEFAULT 1.0,
    
    -- AI insights
    last_perplexity_update TIMESTAMP,
    perplexity_summary TEXT,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- Table: buildings (בניינים)
-- ============================================
CREATE TABLE IF NOT EXISTS buildings (
    id SERIAL PRIMARY KEY,
    complex_id INT NOT NULL REFERENCES complexes(id) ON DELETE CASCADE,
    address VARCHAR(255) NOT NULL,
    street VARCHAR(150),
    house_number VARCHAR(20),
    city VARCHAR(100),
    
    -- Characteristics (מאפיינים)
    year_built INT,
    floors INT,
    units_per_floor INT,
    total_units INT,
    
    -- Prices (מחירים)
    avg_price_sqm DECIMAL(10,2),
    benchmark_price_sqm DECIMAL(10,2),
    building_premium DECIMAL(5,2),
    
    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- Table: transactions (עסקאות)
-- ============================================
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    building_id INT REFERENCES buildings(id) ON DELETE CASCADE,
    complex_id INT REFERENCES complexes(id) ON DELETE CASCADE,
    
    -- Transaction details (פרטי עסקה)
    transaction_date DATE,
    price DECIMAL(12,2),
    area_sqm DECIMAL(8,2),
    rooms DECIMAL(3,1),
    floor INT,
    price_per_sqm DECIMAL(10,2),
    
    -- Address (for matching before building exists)
    address VARCHAR(255),
    city VARCHAR(100),
    
    -- Period relative to project milestones
    period VARCHAR(30),
    -- Values: before_declaration, after_declaration, after_submission,
    --         after_deposit, after_approval, after_permit
    
    -- Source
    source VARCHAR(50) DEFAULT 'nadlan_gov',
    source_id VARCHAR(100),
    
    -- Metadata
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- Table: listings (מודעות למכירה)
-- ============================================
CREATE TABLE IF NOT EXISTS listings (
    id SERIAL PRIMARY KEY,
    building_id INT REFERENCES buildings(id) ON DELETE SET NULL,
    complex_id INT REFERENCES complexes(id) ON DELETE CASCADE,
    
    -- Source info
    source VARCHAR(30) DEFAULT 'yad2',
    source_listing_id VARCHAR(100),
    url VARCHAR(500),
    
    -- Listing details
    asking_price DECIMAL(12,2),
    area_sqm DECIMAL(8,2),
    rooms DECIMAL(3,1),
    floor INT,
    price_per_sqm DECIMAL(10,2),
    
    -- Address
    address VARCHAR(255),
    city VARCHAR(100),
    
    -- Tracking (מעקב)
    first_seen DATE,
    last_seen DATE,
    days_on_market INT DEFAULT 0,
    price_changes INT DEFAULT 0,
    original_price DECIMAL(12,2),
    total_price_drop_percent DECIMAL(5,2) DEFAULT 0,
    
    -- Stress indicators (אינדיקטורי לחץ)
    has_urgent_keywords BOOLEAN DEFAULT FALSE,
    urgent_keywords_found TEXT,
    is_foreclosure BOOLEAN DEFAULT FALSE,
    is_inheritance BOOLEAN DEFAULT FALSE,
    description_snippet TEXT,
    
    -- SSI Score
    ssi_score INT DEFAULT 0,
    ssi_time_score INT DEFAULT 0,
    ssi_price_score INT DEFAULT 0,
    ssi_indicator_score INT DEFAULT 0,
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- Table: benchmarks (השוואות)
-- ============================================
CREATE TABLE IF NOT EXISTS benchmarks (
    id SERIAL PRIMARY KEY,
    building_id INT REFERENCES buildings(id) ON DELETE CASCADE,
    complex_id INT REFERENCES complexes(id) ON DELETE CASCADE,
    
    -- Benchmark building info
    benchmark_address VARCHAR(255),
    benchmark_city VARCHAR(100),
    
    -- Similarity metrics
    distance_meters INT,
    year_built_diff INT,
    floors_diff INT,
    
    -- Benchmark price
    benchmark_price_sqm DECIMAL(10,2),
    num_transactions INT,
    period_start DATE,
    period_end DATE,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- Table: scan_logs (לוגי סריקה)
-- ============================================
CREATE TABLE IF NOT EXISTS scan_logs (
    id SERIAL PRIMARY KEY,
    scan_type VARCHAR(50) NOT NULL,
    -- Types: weekly_full, manual, nadlan, yad2, perplexity, status_check
    
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    
    status VARCHAR(20) DEFAULT 'running',
    -- Values: running, completed, failed, partial
    
    complexes_scanned INT DEFAULT 0,
    new_transactions INT DEFAULT 0,
    new_listings INT DEFAULT 0,
    updated_listings INT DEFAULT 0,
    status_changes INT DEFAULT 0,
    alerts_sent INT DEFAULT 0,
    
    errors TEXT,
    summary TEXT,
    
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- Table: alerts (התראות)
-- ============================================
CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
    complex_id INT REFERENCES complexes(id) ON DELETE CASCADE,
    listing_id INT REFERENCES listings(id) ON DELETE SET NULL,
    
    alert_type VARCHAR(50) NOT NULL,
    -- Types: high_iai, high_ssi, status_change, price_drop, new_opportunity
    
    severity VARCHAR(20) DEFAULT 'info',
    -- Values: critical, warning, info
    
    title VARCHAR(255),
    message TEXT,
    data JSONB,
    
    is_read BOOLEAN DEFAULT FALSE,
    sent_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- Indexes
-- ============================================
CREATE INDEX IF NOT EXISTS idx_complexes_city ON complexes(city);
CREATE INDEX IF NOT EXISTS idx_complexes_status ON complexes(status);
CREATE INDEX IF NOT EXISTS idx_complexes_iai ON complexes(iai_score DESC);
CREATE INDEX IF NOT EXISTS idx_buildings_complex ON buildings(complex_id);
CREATE INDEX IF NOT EXISTS idx_transactions_complex ON transactions(complex_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_listings_complex ON listings(complex_id);
CREATE INDEX IF NOT EXISTS idx_listings_ssi ON listings(ssi_score DESC);
CREATE INDEX IF NOT EXISTS idx_listings_active ON listings(is_active);
CREATE INDEX IF NOT EXISTS idx_alerts_unread ON alerts(is_read, created_at DESC);

-- ============================================
-- Trigger: auto-update updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_complexes_updated_at BEFORE UPDATE ON complexes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_buildings_updated_at BEFORE UPDATE ON buildings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_listings_updated_at BEFORE UPDATE ON listings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
