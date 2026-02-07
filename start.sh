#!/bin/sh
set -e

echo "=== Starting Pinuy Binuy (Postgres + Node) ==="

# Initialize Postgres data directory if needed
if [ ! -f /var/lib/postgresql/data/PG_VERSION ]; then
  echo "[startup] Initializing PostgreSQL data directory..."
  mkdir -p /var/lib/postgresql/data
  chown -R postgres:postgres /var/lib/postgresql/data
  su postgres -c "initdb -D /var/lib/postgresql/data --encoding=UTF8 --locale=C"

  # Configure Postgres for local connections only
  echo "listen_addresses = '127.0.0.1'" >> /var/lib/postgresql/data/postgresql.conf
  echo "port = 5432" >> /var/lib/postgresql/data/postgresql.conf
  echo "max_connections = 30" >> /var/lib/postgresql/data/postgresql.conf
  echo "shared_buffers = 64MB" >> /var/lib/postgresql/data/postgresql.conf

  # Allow local connections without password for simplicity
  echo "local all all trust" > /var/lib/postgresql/data/pg_hba.conf
  echo "host all all 127.0.0.1/32 trust" >> /var/lib/postgresql/data/pg_hba.conf
fi

# Start Postgres in the background
echo "[startup] Starting PostgreSQL..."
su postgres -c "pg_ctl -D /var/lib/postgresql/data -l /var/lib/postgresql/pg.log start -w -t 30"

# Wait for Postgres to be ready
echo "[startup] Waiting for PostgreSQL to accept connections..."
for i in $(seq 1 15); do
  if su postgres -c "pg_isready -h 127.0.0.1 -p 5432" > /dev/null 2>&1; then
    echo "[startup] PostgreSQL is ready!"
    break
  fi
  echo "[startup] Attempt $i/15 - waiting..."
  sleep 1
done

# Create database and user if they don't exist
echo "[startup] Creating database and user..."
su postgres -c "psql -h 127.0.0.1 -c \"SELECT 1 FROM pg_roles WHERE rolname='pinuy_admin'\" | grep -q 1 || psql -h 127.0.0.1 -c \"CREATE USER pinuy_admin WITH PASSWORD 'pinuy_secure_2024' CREATEDB;\""
su postgres -c "psql -h 127.0.0.1 -c \"SELECT 1 FROM pg_database WHERE datname='pinuy_binuy'\" | grep -q 1 || psql -h 127.0.0.1 -c \"CREATE DATABASE pinuy_binuy OWNER pinuy_admin;\""
su postgres -c "psql -h 127.0.0.1 -c \"GRANT ALL PRIVILEGES ON DATABASE pinuy_binuy TO pinuy_admin;\""

echo "[startup] PostgreSQL setup complete"
echo "[startup] Starting Node.js application..."

# Export DATABASE_URL for the Node app
export DATABASE_URL="postgresql://pinuy_admin:pinuy_secure_2024@127.0.0.1:5432/pinuy_binuy"
export DATABASE_SSL="false"

# Start Node.js app (exec replaces shell so signals propagate)
exec node src/index.js
