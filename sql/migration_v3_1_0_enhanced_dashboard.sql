-- Migration: Enhanced Dashboard V3 Features
-- Run this to add all new tables and features for the enhanced dashboard

-- Migration info
-- Version: V3.1.0
-- Date: 2026-03-06
-- Description: Add WhatsApp automation, leads management, and conversion tracking

-- Step 1: Create WhatsApp messages table
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id SERIAL PRIMARY KEY,
    sender_phone VARCHAR(50) NOT NULL,
    sender_name VARCHAR(255),
    message_content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Response tracking
    auto_responded BOOLEAN DEFAULT FALSE,
    auto_response_sent_at TIMESTAMP NULL,
    responded_at TIMESTAMP NULL,
    response_content TEXT NULL,
    
    -- Conversion tracking
    lead_id INTEGER NULL,
    deal_id INTEGER NULL, 
    processed_at TIMESTAMP NULL,
    
    -- Categorization
    message_type VARCHAR(50) DEFAULT 'general',
    priority VARCHAR(20) DEFAULT 'normal',
    status VARCHAR(30) DEFAULT 'new',
    
    -- Metadata
    source_platform VARCHAR(50) DEFAULT 'whatsapp',
    thread_id VARCHAR(255) NULL
);

-- Step 2: Create leads table
CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    
    -- Basic info
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(255) NULL,
    
    -- Lead details
    budget DECIMAL(12,2) NULL,
    property_type VARCHAR(100) NULL,
    location_preference TEXT NULL,
    urgency VARCHAR(20) DEFAULT 'normal',
    
    -- Lead management
    status VARCHAR(30) DEFAULT 'new',
    source VARCHAR(50) NOT NULL,
    assigned_to VARCHAR(255) DEFAULT 'Hemi Michaeli',
    
    -- Conversion tracking
    conversion_score INTEGER DEFAULT 0,
    last_contact_at TIMESTAMP NULL,
    next_followup_at TIMESTAMP NULL,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 3: Create deals table
CREATE TABLE IF NOT EXISTS deals (
    id SERIAL PRIMARY KEY,
    
    lead_id INTEGER NOT NULL,
    property_address TEXT NOT NULL,
    property_type VARCHAR(100) NOT NULL,
    
    purchase_price DECIMAL(12,2) NOT NULL,
    commission_amount DECIMAL(12,2) NOT NULL,
    commission_percentage DECIMAL(5,2) NOT NULL,
    
    status VARCHAR(30) DEFAULT 'pending',
    closing_date DATE NULL,
    
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 4: Create call logs table
CREATE TABLE IF NOT EXISTS call_logs (
    id SERIAL PRIMARY KEY,
    
    phone VARCHAR(50) NOT NULL,
    type VARCHAR(20) NOT NULL,
    duration INTEGER DEFAULT 0,
    status VARCHAR(30) NOT NULL,
    
    lead_id INTEGER NULL,
    listing_id INTEGER NULL,
    
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 5: Create message templates table
CREATE TABLE IF NOT EXISTS message_templates (
    id SERIAL PRIMARY KEY,
    
    name VARCHAR(255) NOT NULL,
    template_text TEXT NOT NULL,
    template_type VARCHAR(50) NOT NULL,
    
    usage_count INTEGER DEFAULT 0,
    success_rate DECIMAL(5,2) DEFAULT 0.0,
    
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 6: Add foreign key constraints (after tables exist)
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_messages' AND table_name = 'leads') THEN
        ALTER TABLE whatsapp_messages 
        ADD CONSTRAINT IF NOT EXISTS fk_whatsapp_lead 
        FOREIGN KEY (lead_id) REFERENCES leads(id);
    END IF;
    
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_messages' AND table_name = 'deals') THEN
        ALTER TABLE whatsapp_messages 
        ADD CONSTRAINT IF NOT EXISTS fk_whatsapp_deal 
        FOREIGN KEY (deal_id) REFERENCES deals(id);
    END IF;
    
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'deals' AND table_name = 'leads') THEN
        ALTER TABLE deals 
        ADD CONSTRAINT IF NOT EXISTS fk_deals_lead 
        FOREIGN KEY (lead_id) REFERENCES leads(id);
    END IF;
    
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'call_logs' AND table_name = 'leads') THEN
        ALTER TABLE call_logs 
        ADD CONSTRAINT IF NOT EXISTS fk_calls_lead 
        FOREIGN KEY (lead_id) REFERENCES leads(id);
    END IF;
END $$;

-- Step 7: Enhance existing tables
DO $$
BEGIN
    -- Add columns to yad2_listings if table exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'yad2_listings') THEN
        ALTER TABLE yad2_listings 
        ADD COLUMN IF NOT EXISTS contact_attempts INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMP NULL,
        ADD COLUMN IF NOT EXISTS contact_status VARCHAR(30) DEFAULT 'not_contacted',
        ADD COLUMN IF NOT EXISTS lead_potential VARCHAR(20) DEFAULT 'unknown',
        ADD COLUMN IF NOT EXISTS notes TEXT NULL;
    END IF;
    
    -- Add columns to complexes if table exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'complexes') THEN
        ALTER TABLE complexes
        ADD COLUMN IF NOT EXISTS last_market_analysis TIMESTAMP NULL,
        ADD COLUMN IF NOT EXISTS market_trend VARCHAR(20) DEFAULT 'stable',
        ADD COLUMN IF NOT EXISTS investor_interest VARCHAR(20) DEFAULT 'medium',
        ADD COLUMN IF NOT EXISTS recent_activity_score INTEGER DEFAULT 50;
    END IF;
END $$;

-- Step 8: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_phone ON whatsapp_messages(sender_phone);
CREATE INDEX IF NOT EXISTS idx_whatsapp_created_at ON whatsapp_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_whatsapp_status ON whatsapp_messages(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_lead_id ON whatsapp_messages(lead_id);

CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_budget ON leads(budget);

CREATE INDEX IF NOT EXISTS idx_deals_lead_id ON deals(lead_id);
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
CREATE INDEX IF NOT EXISTS idx_deals_closing_date ON deals(closing_date);

CREATE INDEX IF NOT EXISTS idx_calls_phone ON call_logs(phone);
CREATE INDEX IF NOT EXISTS idx_calls_type ON call_logs(type);
CREATE INDEX IF NOT EXISTS idx_calls_created_at ON call_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_calls_lead_id ON call_logs(lead_id);

CREATE INDEX IF NOT EXISTS idx_templates_type ON message_templates(template_type);
CREATE INDEX IF NOT EXISTS idx_templates_active ON message_templates(is_active);

-- Enhanced table indexes
CREATE INDEX IF NOT EXISTS idx_yad2_contact_status ON yad2_listings(contact_status);
CREATE INDEX IF NOT EXISTS idx_yad2_lead_potential ON yad2_listings(lead_potential);
CREATE INDEX IF NOT EXISTS idx_complexes_market_trend ON complexes(market_trend);
CREATE INDEX IF NOT EXISTS idx_complexes_investor_interest ON complexes(investor_interest);

-- Step 9: Insert default message templates
INSERT INTO message_templates (name, template_text, template_type, is_active) VALUES 
('QUANTUM Welcome Message', 
'שלום! תודה על פנייתך ל-QUANTUM.

אנחנו מתמחים בפינוי-בינוי ונשמח לעזור לך.

✅ מה אנחנו יכולים לעשות עבורך?
• ניתוח הזדמנויות השקעה
• ליווי מכירת דירה לפינוי-בינוי  
• חיפוש נכסים מתאימים

אנא ספר לי קצת על מה אתה מחפש ואחזור אליך בהקדם.

חמי מיכאלי | QUANTUM', 'welcome', true),

('QUANTUM Follow Up', 
'שלום שוב,

רק רציתי לוודא שקיבלת את ההודעה שלי והאם יש לך שאלות נוספות?

אני זמין לכל שאלה או פגישה.

חמי | QUANTUM', 'follow_up', true),

('QUANTUM Lead Qualification', 
'תודה על העניין!

כדי שאוכל לעזור לך בצורה הטובה ביותר, יכול תספר לי:

🏠 איזה סוג נכס מחפש?
💰 מה התקציב שלך?
📍 איזור מעדיף?
⏰ מתי מתכנן לרכוש?

חמי | QUANTUM', 'qualification', true)
ON CONFLICT DO NOTHING;

-- Step 10: Migration completion log
INSERT INTO migration_log (migration_name, migration_version, executed_at) 
VALUES ('Enhanced Dashboard V3', 'V3.1.0', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- Create migration log table if it doesn't exist
CREATE TABLE IF NOT EXISTS migration_log (
    id SERIAL PRIMARY KEY,
    migration_name VARCHAR(255) NOT NULL,
    migration_version VARCHAR(50) NOT NULL,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(migration_name, migration_version)
);