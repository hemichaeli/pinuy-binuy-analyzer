-- QUANTUM AI Sales Bot - Database Migration for Sales Intelligence
-- Add sales intelligence fields to leads table

-- Add new columns for sales intelligence (if they don't exist)
ALTER TABLE leads 
ADD COLUMN IF NOT EXISTS current_broker VARCHAR(20),
ADD COLUMN IF NOT EXISTS satisfaction_level VARCHAR(20),
ADD COLUMN IF NOT EXISTS urgency VARCHAR(20),
ADD COLUMN IF NOT EXISTS property_value VARCHAR(50),
ADD COLUMN IF NOT EXISTS decision_maker VARCHAR(20),
ADD COLUMN IF NOT EXISTS main_objection VARCHAR(50),
ADD COLUMN IF NOT EXISTS sales_stage VARCHAR(30),
ADD COLUMN IF NOT EXISTS confidence_score INTEGER,
ADD COLUMN IF NOT EXISTS close_attempt VARCHAR(30),
ADD COLUMN IF NOT EXISTS last_interaction TIMESTAMP;

-- Create indexes for better performance on sales queries
CREATE INDEX IF NOT EXISTS idx_leads_sales_stage ON leads(sales_stage);
CREATE INDEX IF NOT EXISTS idx_leads_confidence ON leads(confidence_score);
CREATE INDEX IF NOT EXISTS idx_leads_current_broker ON leads(current_broker);
CREATE INDEX IF NOT EXISTS idx_leads_status_stage ON leads(status, sales_stage);

-- Create sales dashboard view for analytics
CREATE OR REPLACE VIEW sales_dashboard AS
SELECT 
    COUNT(*) as total_leads,
    COUNT(*) FILTER (WHERE status = 'new') as new_leads,
    COUNT(*) FILTER (WHERE sales_stage = 'qualifying') as qualifying,
    COUNT(*) FILTER (WHERE sales_stage = 'presenting') as presenting,
    COUNT(*) FILTER (WHERE sales_stage = 'closing') as closing,
    COUNT(*) FILTER (WHERE current_broker = 'yes') as with_competition,
    COUNT(*) FILTER (WHERE current_broker = 'no') as open_field,
    COUNT(*) FILTER (WHERE current_broker = 'shopping') as shopping_around,
    COUNT(*) FILTER (WHERE confidence_score >= 8) as high_confidence,
    COUNT(*) FILTER (WHERE confidence_score BETWEEN 5 AND 7) as medium_confidence,
    COUNT(*) FILTER (WHERE confidence_score < 5) as low_confidence,
    COUNT(*) FILTER (WHERE status = 'disqualified') as disqualified,
    AVG(confidence_score) as avg_confidence,
    COUNT(*) FILTER (WHERE user_type = 'seller' AND current_broker = 'yes') as seller_competition,
    COUNT(*) FILTER (WHERE user_type = 'buyer' AND urgency = 'high') as urgent_buyers,
    COUNT(*) FILTER (WHERE property_value ILIKE '%פינוי%' OR property_value ILIKE '%בינוי%') as pinuy_binuy_leads
FROM leads 
WHERE created_at >= CURRENT_DATE - INTERVAL '30 days';

-- Create lead scoring function
CREATE OR REPLACE FUNCTION calculate_lead_score(
    p_user_type VARCHAR,
    p_current_broker VARCHAR,
    p_satisfaction_level VARCHAR,
    p_urgency VARCHAR,
    p_decision_maker VARCHAR,
    p_property_value VARCHAR,
    p_budget VARCHAR
) RETURNS INTEGER AS $$
DECLARE
    score INTEGER := 0;
BEGIN
    -- Base score by user type
    IF p_user_type = 'seller' THEN score := score + 5; END IF;
    IF p_user_type = 'buyer' THEN score := score + 4; END IF;
    
    -- Broker situation scoring
    CASE p_current_broker
        WHEN 'no' THEN score := score + 8;        -- Open field - best scenario
        WHEN 'shopping' THEN score := score + 6;  -- Shopping around - good potential
        WHEN 'yes' THEN 
            CASE p_satisfaction_level
                WHEN 'low' THEN score := score + 7;      -- Unhappy with current broker
                WHEN 'medium' THEN score := score + 4;   -- Somewhat satisfied
                WHEN 'high' THEN score := score + 1;     -- Happy with current broker
            END CASE;
    END CASE;
    
    -- Urgency scoring
    CASE p_urgency
        WHEN 'high' THEN score := score + 5;
        WHEN 'medium' THEN score := score + 3;
        WHEN 'low' THEN score := score + 1;
    END CASE;
    
    -- Decision maker scoring
    CASE p_decision_maker
        WHEN 'yes' THEN score := score + 4;
        WHEN 'partial' THEN score := score + 2;
    END CASE;
    
    -- Property value bonus (פינוי-בינוי expertise)
    IF p_property_value ILIKE '%פינוי%' OR p_property_value ILIKE '%בינוי%' THEN
        score := score + 3;
    END IF;
    
    -- High budget bonus
    IF p_budget ILIKE '%מליון%' OR p_budget::TEXT ~ '[5-9][0-9]' THEN
        score := score + 2;
    END IF;
    
    RETURN LEAST(score, 10); -- Cap at 10
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-calculate confidence score
CREATE OR REPLACE FUNCTION update_confidence_score() RETURNS TRIGGER AS $$
BEGIN
    NEW.confidence_score := calculate_lead_score(
        NEW.user_type,
        NEW.current_broker,
        NEW.satisfaction_level,
        NEW.urgency,
        NEW.decision_maker,
        NEW.property_value,
        NEW.budget
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_confidence ON leads;
CREATE TRIGGER trigger_update_confidence
    BEFORE INSERT OR UPDATE ON leads
    FOR EACH ROW
    EXECUTE FUNCTION update_confidence_score();

-- Update existing leads with calculated scores
UPDATE leads 
SET confidence_score = calculate_lead_score(
    user_type,
    current_broker,
    satisfaction_level,
    urgency,
    decision_maker,
    property_value,
    budget
)
WHERE confidence_score IS NULL;

-- Create sales performance tracking table
CREATE TABLE IF NOT EXISTS sales_performance (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id),
    interaction_type VARCHAR(50), -- 'qualification', 'objection_handling', 'closing_attempt'
    success BOOLEAN,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for sales performance
CREATE INDEX IF NOT EXISTS idx_sales_performance_lead ON sales_performance(lead_id);
CREATE INDEX IF NOT EXISTS idx_sales_performance_type ON sales_performance(interaction_type);
CREATE INDEX IF NOT EXISTS idx_sales_performance_date ON sales_performance(created_at);

-- Grant permissions
GRANT SELECT ON sales_dashboard TO public;
GRANT EXECUTE ON FUNCTION calculate_lead_score TO public;
GRANT ALL ON sales_performance TO public;

-- Insert sample performance data for testing
INSERT INTO sales_performance (lead_id, interaction_type, success, notes)
SELECT 
    id, 
    'qualification', 
    CASE WHEN confidence_score >= 7 THEN true ELSE false END,
    'AI qualification completed'
FROM leads 
WHERE confidence_score IS NOT NULL
ON CONFLICT DO NOTHING;

COMMENT ON TABLE leads IS 'Enhanced with AI Sales Intelligence fields';
COMMENT ON VIEW sales_dashboard IS 'Real-time sales analytics dashboard';
COMMENT ON FUNCTION calculate_lead_score IS 'AI-powered lead scoring algorithm';
COMMENT ON TABLE sales_performance IS 'Sales interaction tracking and performance metrics';
