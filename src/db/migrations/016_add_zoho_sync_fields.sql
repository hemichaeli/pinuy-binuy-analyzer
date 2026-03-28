-- 016_add_zoho_sync_fields.sql
-- Add Zoho CRM sync tracking columns to leads table

-- sync_status: 'pending' | 'synced' | 'failed' | 'skipped'
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sync_status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS zoho_id VARCHAR(50);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS zoho_synced_at TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS zoho_sync_error TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_sync_status ON leads (sync_status);
CREATE INDEX IF NOT EXISTS idx_leads_zoho_id ON leads (zoho_id);
