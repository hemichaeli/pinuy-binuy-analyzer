-- 016: add lang column to newsletter_subscribers
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS lang VARCHAR(5) DEFAULT 'he';
CREATE INDEX IF NOT EXISTS idx_newsletter_lang ON newsletter_subscribers(lang);
