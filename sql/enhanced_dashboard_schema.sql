-- Enhanced Dashboard V3 Database Schema
-- Adding tables for WhatsApp automation, leads management, and conversion tracking

-- WhatsApp Messages table for incoming message management
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
    lead_id INTEGER NULL REFERENCES leads(id),
    deal_id INTEGER NULL REFERENCES deals(id),
    processed_at TIMESTAMP NULL,
    
    -- Categorization
    message_type VARCHAR(50) DEFAULT 'general', -- 'inquiry', 'follow_up', 'complaint', etc.
    priority VARCHAR(20) DEFAULT 'normal', -- 'low', 'normal', 'high', 'urgent'
    status VARCHAR(30) DEFAULT 'new', -- 'new', 'read', 'responded', 'converted', 'closed'
    
    -- Metadata
    source_platform VARCHAR(50) DEFAULT 'whatsapp',
    thread_id VARCHAR(255) NULL, -- For grouping related messages
    
    INDEX idx_sender_phone (sender_phone),
    INDEX idx_created_at (created_at),
    INDEX idx_status (status),
    INDEX idx_lead_id (lead_id)
);

-- Leads table for managing potential customers
CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    
    -- Basic info
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(255) NULL,
    
    -- Lead details
    budget DECIMAL(12,2) NULL, -- Budget in NIS
    property_type VARCHAR(100) NULL, -- 'apartment', 'house', 'commercial', etc.
    location_preference TEXT NULL,
    urgency VARCHAR(20) DEFAULT 'normal', -- 'low', 'normal', 'high', 'urgent'
    
    -- Lead management
    status VARCHAR(30) DEFAULT 'new', -- 'new', 'contacted', 'qualified', 'negotiating', 'closed', 'lost'
    source VARCHAR(50) NOT NULL, -- 'whatsapp', 'website', 'referral', 'yad2', etc.
    assigned_to VARCHAR(255) DEFAULT 'Hemi Michaeli',
    
    -- Conversion tracking
    conversion_score INTEGER DEFAULT 0, -- 0-100 score based on engagement
    last_contact_at TIMESTAMP NULL,
    next_followup_at TIMESTAMP NULL,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_phone (phone),
    INDEX idx_status (status),
    INDEX idx_source (source),
    INDEX idx_created_at (created_at),
    INDEX idx_budget (budget)
);

-- Deals table for closed transactions
CREATE TABLE IF NOT EXISTS deals (
    id SERIAL PRIMARY KEY,
    
    -- Deal info
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    property_address TEXT NOT NULL,
    property_type VARCHAR(100) NOT NULL,
    
    -- Financial details
    purchase_price DECIMAL(12,2) NOT NULL,
    commission_amount DECIMAL(12,2) NOT NULL,
    commission_percentage DECIMAL(5,2) NOT NULL,
    
    -- Deal status
    status VARCHAR(30) DEFAULT 'pending', -- 'pending', 'contracts_signed', 'closed', 'cancelled'
    closing_date DATE NULL,
    
    -- Metadata
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_lead_id (lead_id),
    INDEX idx_status (status),
    INDEX idx_closing_date (closing_date)
);

-- Call logs for tracking communication
CREATE TABLE IF NOT EXISTS call_logs (
    id SERIAL PRIMARY KEY,
    
    phone VARCHAR(50) NOT NULL,
    type VARCHAR(20) NOT NULL, -- 'inbound', 'outbound'
    duration INTEGER DEFAULT 0, -- Duration in seconds
    status VARCHAR(30) NOT NULL, -- 'completed', 'missed', 'busy', 'no_answer'
    
    -- Connected entities
    lead_id INTEGER NULL REFERENCES leads(id),
    listing_id INTEGER NULL, -- Reference to yad2_listings or other listing tables
    
    -- Call details
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_phone (phone),
    INDEX idx_type (type),
    INDEX idx_created_at (created_at),
    INDEX idx_lead_id (lead_id)
);

-- Enhanced yad2_listings table - Add conversion tracking columns
ALTER TABLE yad2_listings 
ADD COLUMN IF NOT EXISTS contact_attempts INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMP NULL,
ADD COLUMN IF NOT EXISTS contact_status VARCHAR(30) DEFAULT 'not_contacted', -- 'not_contacted', 'attempted', 'contacted', 'responsive', 'not_responsive'
ADD COLUMN IF NOT EXISTS lead_potential VARCHAR(20) DEFAULT 'unknown', -- 'low', 'medium', 'high', 'unknown'
ADD COLUMN IF NOT EXISTS notes TEXT NULL;

-- Enhanced complexes table - Add market intelligence
ALTER TABLE complexes
ADD COLUMN IF NOT EXISTS last_market_analysis TIMESTAMP NULL,
ADD COLUMN IF NOT EXISTS market_trend VARCHAR(20) DEFAULT 'stable', -- 'rising', 'falling', 'stable', 'volatile'
ADD COLUMN IF NOT EXISTS investor_interest VARCHAR(20) DEFAULT 'medium', -- 'low', 'medium', 'high'
ADD COLUMN IF NOT EXISTS recent_activity_score INTEGER DEFAULT 50; -- 0-100 score based on recent listings, sales, etc.

-- Message templates for automated responses
CREATE TABLE IF NOT EXISTS message_templates (
    id SERIAL PRIMARY KEY,
    
    name VARCHAR(255) NOT NULL,
    template_text TEXT NOT NULL,
    template_type VARCHAR(50) NOT NULL, -- 'welcome', 'follow_up', 'qualification', 'closing'
    
    -- Usage tracking
    usage_count INTEGER DEFAULT 0,
    success_rate DECIMAL(5,2) DEFAULT 0.0, -- Response rate for this template
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_template_type (template_type),
    INDEX idx_is_active (is_active)
);

-- Insert default message templates
INSERT INTO message_templates (name, template_text, template_type) VALUES 
('Welcome Message', 
'שלום! תודה על פנייתך ל-QUANTUM. 

אנחנו מתמחים בפינוי-בינוי ונשמח לעזור לך.

✅ מה אנחנו יכולים לעשות עבורך?
• ניתוח הזדמנויות השקעה
• ליווי מכירת דירה לפינוי-בינוי  
• חיפוש נכסים מתאימים

אנא ספר לי קצת על מה אתה מחפש ואחזור אליך בהקדם.

חמי מיכאלי | QUANTUM', 'welcome'),

('Follow Up', 
'שלום שוב,

רק רציתי לוודא שקיבלת את ההודעה שלי והאם יש לך שאלות נוספות לגבי הנכס?

אני זמין לכל שאלה או פגישה.

חמי | QUANTUM', 'follow_up'),

('Qualification', 
'תודה על העניין!

כדי שאוכל לעזור לך בצורה הטובה ביותר, יכול תספר לי:

🏠 איזה סוג נכס מחפש?
💰 מה התקציב שלך?
📍 איזור מעדיף?
⏰ מתי מתכנן לרכוש?

חמי | QUANTUM', 'qualification');

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_yad2_contact_status ON yad2_listings(contact_status);
CREATE INDEX IF NOT EXISTS idx_yad2_lead_potential ON yad2_listings(lead_potential);
CREATE INDEX IF NOT EXISTS idx_complexes_market_trend ON complexes(market_trend);
CREATE INDEX IF NOT EXISTS idx_complexes_investor_interest ON complexes(investor_interest);