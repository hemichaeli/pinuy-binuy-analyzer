-- Migration: Create read-only user for external platform access (Zoho, BI tools, etc.)
-- This user can only SELECT data, cannot modify or delete anything

DO $$
BEGIN
    -- Create read-only user if not exists
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'quantum_readonly') THEN
        CREATE USER quantum_readonly WITH PASSWORD 'QntmR3ad0nly2025!Sec';
    END IF;
END
$$;

-- Grant connect permission
GRANT CONNECT ON DATABASE railway TO quantum_readonly;

-- Grant usage on schema
GRANT USAGE ON SCHEMA public TO quantum_readonly;

-- Grant SELECT on all existing tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO quantum_readonly;

-- Grant SELECT on all existing sequences (for ID lookups)
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO quantum_readonly;

-- Ensure future tables also get SELECT permission
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO quantum_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO quantum_readonly;

-- Log the creation
DO $$
BEGIN
    RAISE NOTICE 'Read-only user quantum_readonly created successfully';
END
$$;
