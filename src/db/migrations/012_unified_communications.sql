-- ═══════════════════════════════════════════════════════════════
-- Migration 012: Unified Communications
-- Adds: outgoing_listings, buyer_conversations, buyer_messages,
--        seller_inbound (sellers who contacted us), 
--        and extends whatsapp_conversations with contact_type
-- ═══════════════════════════════════════════════════════════════

-- ── 1. outgoing_listings: properties we publish for sale/rent ──
CREATE TABLE IF NOT EXISTS outgoing_listings (
  id                  SERIAL PRIMARY KEY,
  title               TEXT NOT NULL,
  description         TEXT,
  property_type       TEXT DEFAULT 'apartment',  -- apartment | penthouse | garden | duplex | other
  deal_type           TEXT DEFAULT 'sale',        -- sale | rent
  price               INTEGER,
  rooms               NUMERIC(3,1),
  floor               INTEGER,
  total_floors        INTEGER,
  size_sqm            INTEGER,
  address             TEXT,
  city                TEXT,
  neighborhood        TEXT,
  complex_id          INTEGER REFERENCES complexes(id) ON DELETE SET NULL,
  -- Media
  images              JSONB DEFAULT '[]',         -- array of image URLs
  -- Publishing status per platform
  published_yad2      BOOLEAN DEFAULT FALSE,
  yad2_listing_id     TEXT,
  yad2_published_at   TIMESTAMPTZ,
  published_facebook  BOOLEAN DEFAULT FALSE,
  facebook_listing_id TEXT,
  facebook_published_at TIMESTAMPTZ,
  published_homeless  BOOLEAN DEFAULT FALSE,
  homeless_listing_id TEXT,
  homeless_published_at TIMESTAMPTZ,
  published_madlan    BOOLEAN DEFAULT FALSE,
  madlan_listing_id   TEXT,
  madlan_published_at TIMESTAMPTZ,
  published_winwin    BOOLEAN DEFAULT FALSE,
  winwin_listing_id   TEXT,
  winwin_published_at TIMESTAMPTZ,
  -- Source tracking
  source              TEXT DEFAULT 'manual',      -- manual | flyer_response | seller_inbound
  source_contact_id   INTEGER,                    -- FK to seller_inbound if applicable
  -- Status
  status              TEXT DEFAULT 'draft',       -- draft | active | paused | sold | rented
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outgoing_listings_status ON outgoing_listings(status);
CREATE INDEX IF NOT EXISTS idx_outgoing_listings_city ON outgoing_listings(city);
CREATE INDEX IF NOT EXISTS idx_outgoing_listings_complex ON outgoing_listings(complex_id);

-- ── 2. seller_inbound: sellers who contacted us (flyer/campaign) ──
CREATE TABLE IF NOT EXISTS seller_inbound (
  id              SERIAL PRIMARY KEY,
  phone           TEXT NOT NULL,
  name            TEXT,
  source          TEXT DEFAULT 'flyer',   -- flyer | facebook_campaign | google_campaign | instagram | referral | other
  campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  -- Property details they shared
  address         TEXT,
  city            TEXT,
  property_type   TEXT,
  asking_price    INTEGER,
  notes           TEXT,
  -- Status
  status          TEXT DEFAULT 'new',     -- new | in_conversation | qualified | listing_created | closed | not_relevant
  assigned_to     TEXT,                   -- agent name
  outgoing_listing_id INTEGER REFERENCES outgoing_listings(id) ON DELETE SET NULL,
  -- Timestamps
  first_contact_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seller_inbound_phone ON seller_inbound(phone);
CREATE INDEX IF NOT EXISTS idx_seller_inbound_status ON seller_inbound(status);
CREATE INDEX IF NOT EXISTS idx_seller_inbound_source ON seller_inbound(source);

-- ── 3. buyer_conversations: buyers from campaigns/our ads ──
CREATE TABLE IF NOT EXISTS buyer_conversations (
  id              SERIAL PRIMARY KEY,
  phone           TEXT NOT NULL,
  name            TEXT,
  source          TEXT DEFAULT 'unknown', -- facebook_ad | google_ad | instagram_ad | yad2_listing | homeless_listing | madlan_listing | winwin_listing | referral | other
  campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  outgoing_listing_id INTEGER REFERENCES outgoing_listings(id) ON DELETE SET NULL,
  -- Buyer profile
  budget_min      INTEGER,
  budget_max      INTEGER,
  rooms_min       NUMERIC(3,1),
  rooms_max       NUMERIC(3,1),
  preferred_cities TEXT[],
  -- Status
  status          TEXT DEFAULT 'new',     -- new | in_conversation | qualified | showing_scheduled | offer_made | closed | not_relevant
  assigned_to     TEXT,
  -- WhatsApp conversation link
  wa_conversation_id INTEGER REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
  -- Timestamps
  first_contact_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buyer_conversations_phone ON buyer_conversations(phone);
CREATE INDEX IF NOT EXISTS idx_buyer_conversations_status ON buyer_conversations(status);
CREATE INDEX IF NOT EXISTS idx_buyer_conversations_source ON buyer_conversations(source);

-- ── 4. buyer_messages: messages with buyers ──
CREATE TABLE IF NOT EXISTS buyer_messages (
  id              SERIAL PRIMARY KEY,
  buyer_id        INTEGER NOT NULL REFERENCES buyer_conversations(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL DEFAULT 'outgoing',  -- incoming | outgoing
  channel         TEXT NOT NULL DEFAULT 'whatsapp',  -- whatsapp | sms | email
  message         TEXT NOT NULL,
  external_id     TEXT,
  status          TEXT DEFAULT 'sent',               -- sent | delivered | read | failed
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buyer_messages_buyer ON buyer_messages(buyer_id);
CREATE INDEX IF NOT EXISTS idx_buyer_messages_created ON buyer_messages(created_at DESC);

-- ── 5. seller_inbound_messages: messages with inbound sellers ──
CREATE TABLE IF NOT EXISTS seller_inbound_messages (
  id              SERIAL PRIMARY KEY,
  seller_id       INTEGER NOT NULL REFERENCES seller_inbound(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL DEFAULT 'outgoing',  -- incoming | outgoing
  channel         TEXT NOT NULL DEFAULT 'whatsapp',  -- whatsapp | sms
  message         TEXT NOT NULL,
  external_id     TEXT,
  status          TEXT DEFAULT 'sent',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seller_inbound_messages_seller ON seller_inbound_messages(seller_id);

-- ── 6. Add contact_type to whatsapp_conversations (seller_outbound = we contacted them) ──
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS contact_type TEXT DEFAULT 'seller_outbound';
-- contact_type: seller_outbound | seller_inbound | buyer
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS contact_ref_id INTEGER;
-- contact_ref_id: FK to seller_inbound.id or buyer_conversations.id depending on contact_type

-- ── 7. Add wa_conversation_id to seller_inbound ──
ALTER TABLE seller_inbound ADD COLUMN IF NOT EXISTS wa_conversation_id INTEGER REFERENCES whatsapp_conversations(id) ON DELETE SET NULL;
