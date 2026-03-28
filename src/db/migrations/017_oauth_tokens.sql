-- 015_oauth_tokens.sql
-- OAuth2 token storage for Google Calendar user-facing auth flow

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(50) NOT NULL DEFAULT 'google_calendar',
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expiry_date BIGINT,
  scope TEXT,
  project_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Unique constraint for upsert: one token per provider+project
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_tokens_provider_project
  ON oauth_tokens (provider, COALESCE(project_id, 0));

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider
  ON oauth_tokens (provider);
