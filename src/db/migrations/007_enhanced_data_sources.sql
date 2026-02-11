-- Migration 007: Enhanced data sources
-- Adds tables and columns for:
-- 1. Madlan transaction data
-- 2. Urban Renewal Authority official data
-- 3. Committee protocols and decisions
-- 4. Developer/company information

-- =====================================================
-- 1. MADLAN DATA - Enhanced transaction tracking
-- =====================================================

ALTER TABLE complexes ADD COLUMN IF NOT EXISTS madlan_avg_price_sqm INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS madlan_price_trend DECIMAL(5,2);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_madlan_update TIMESTAMP;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS building_year INTEGER;

-- =====================================================
-- 2. URBAN RENEWAL AUTHORITY - Official declarations
-- =====================================================

ALTER TABLE complexes ADD COLUMN IF NOT EXISTS declaration_track VARCHAR(50); -- 'tax' or 'local_authority'
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS declaration_date DATE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS declaration_number VARCHAR(100);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_existing_units INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_planned_units INTEGER;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_boundaries TEXT;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS gazette_reference VARCHAR(200);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS declaration_expiry DATE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_source VARCHAR(100);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS official_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS verification_date TIMESTAMP;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS verification_notes JSONB;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_official_sync TIMESTAMP;

-- =====================================================
-- 3. COMMITTEE PROTOCOLS - Planning decisions
-- =====================================================

ALTER TABLE complexes ADD COLUMN IF NOT EXISTS has_objections BOOLEAN DEFAULT FALSE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS objections_count INTEGER DEFAULT 0;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS objections_status VARCHAR(100);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS next_objection_hearing DATE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS plan_stage VARCHAR(100);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS deposit_date DATE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS approval_date DATE;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS permit_expected VARCHAR(20);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS last_committee_update TIMESTAMP;

-- Committee decisions table
CREATE TABLE IF NOT EXISTS committee_decisions (
    id SERIAL PRIMARY KEY,
    complex_id INTEGER REFERENCES complexes(id) ON DELETE CASCADE,
    decision_date DATE,
    committee VARCHAR(200),
    decision_type VARCHAR(100),
    subject TEXT,
    details TEXT,
    vote VARCHAR(100),
    conditions JSONB,
    next_steps TEXT,
    protocol_reference VARCHAR(200),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_committee_decisions_complex ON committee_decisions(complex_id);
CREATE INDEX IF NOT EXISTS idx_committee_decisions_date ON committee_decisions(decision_date DESC);
CREATE INDEX IF NOT EXISTS idx_committee_decisions_type ON committee_decisions(decision_type);

-- Upcoming hearings table
CREATE TABLE IF NOT EXISTS upcoming_hearings (
    id SERIAL PRIMARY KEY,
    complex_id INTEGER REFERENCES complexes(id) ON DELETE CASCADE,
    hearing_date DATE NOT NULL,
    committee VARCHAR(200),
    subject TEXT,
    agenda_item VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(complex_id, hearing_date, committee)
);

CREATE INDEX IF NOT EXISTS idx_upcoming_hearings_date ON upcoming_hearings(hearing_date);

-- =====================================================
-- 4. DEVELOPERS - Company intelligence
-- =====================================================

CREATE TABLE IF NOT EXISTS developers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(500) NOT NULL UNIQUE,
    registration_number VARCHAR(50),
    registration_status VARCHAR(50),
    founded_year INTEGER,
    registered_address TEXT,
    
    -- Financial health
    financial_status VARCHAR(50), -- good/warning/critical
    bank_restrictions BOOLEAN DEFAULT FALSE,
    liens_count INTEGER DEFAULT 0,
    mortgages_count INTEGER DEFAULT 0,
    
    -- Track record
    total_projects INTEGER DEFAULT 0,
    completed_projects INTEGER DEFAULT 0,
    delivery_history VARCHAR(100),
    customer_satisfaction VARCHAR(50),
    
    -- Legal issues
    has_lawsuits BOOLEAN DEFAULT FALSE,
    lawsuit_count INTEGER DEFAULT 0,
    receiver_appointed BOOLEAN DEFAULT FALSE,
    bankruptcy_proceedings BOOLEAN DEFAULT FALSE,
    
    -- Contractor license
    contractor_license_category VARCHAR(100),
    license_valid_until DATE,
    
    -- Risk assessment
    risk_score VARCHAR(50), -- low/medium/high/critical
    risk_factors JSONB,
    
    -- Detailed data
    ownership_data JSONB,
    track_record_data JSONB,
    
    -- Metadata
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_developers_risk ON developers(risk_score);
CREATE INDEX IF NOT EXISTS idx_developers_name ON developers(name);

-- Developer news tracking
CREATE TABLE IF NOT EXISTS developer_news (
    id SERIAL PRIMARY KEY,
    developer_id INTEGER REFERENCES developers(id) ON DELETE CASCADE,
    news_date DATE,
    source VARCHAR(200),
    headline TEXT,
    sentiment VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(developer_id, news_date, headline)
);

-- Link complexes to developers
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS developer_id INTEGER REFERENCES developers(id);

-- =====================================================
-- 5. ENHANCED ALERTS
-- =====================================================

-- Add new alert types
ALTER TABLE alerts ALTER COLUMN alert_type TYPE VARCHAR(100);

-- =====================================================
-- 6. INDEXES FOR PERFORMANCE
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_complexes_declaration_track ON complexes(declaration_track);
CREATE INDEX IF NOT EXISTS idx_complexes_official_sync ON complexes(last_official_sync);
CREATE INDEX IF NOT EXISTS idx_complexes_committee_update ON complexes(last_committee_update);
CREATE INDEX IF NOT EXISTS idx_complexes_madlan_update ON complexes(last_madlan_update);
CREATE INDEX IF NOT EXISTS idx_complexes_developer_id ON complexes(developer_id);

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON COLUMN complexes.declaration_track IS 'Tax track (מסלול מיסוי) or Local Authority track (מסלול רשויות מקומיות)';
COMMENT ON COLUMN complexes.gazette_reference IS 'Reference to official gazette publication (רשומות)';
COMMENT ON COLUMN developers.risk_score IS 'Overall risk assessment: low, medium, high, critical';
COMMENT ON TABLE committee_decisions IS 'Stores planning committee decisions and approvals';
COMMENT ON TABLE developers IS 'Developer/company information from Registrar of Companies';
