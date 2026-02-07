#!/bin/bash
set -e

echo "=== Pinuy Binuy Startup ==="
echo "User: $(whoami)"
echo "Node: $(node --version)"

# Ensure PostgreSQL data directory exists and is owned by postgres user
PGDATA="/var/lib/postgresql/data"

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "Initializing PostgreSQL database..."
  mkdir -p "$PGDATA"
  chown -R postgres:postgres "$PGDATA"
  su postgres -c "/usr/lib/postgresql/16/bin/initdb -D $PGDATA"
  echo "host all all 0.0.0.0/0 md5" >> "$PGDATA/pg_hba.conf"
  echo "host all all ::0/0 md5" >> "$PGDATA/pg_hba.conf"
  echo "listen_addresses='localhost'" >> "$PGDATA/postgresql.conf"
fi

# Ensure ownership
chown -R postgres:postgres "$PGDATA"

# Start PostgreSQL
echo "Starting PostgreSQL..."
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -l /tmp/postgresql.log start -w -t 30"

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to accept connections..."
for i in $(seq 1 30); do
  if su postgres -c "/usr/lib/postgresql/16/bin/pg_isready -h localhost" > /dev/null 2>&1; then
    echo "PostgreSQL is ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "ERROR: PostgreSQL failed to start. Logs:"
    cat /tmp/postgresql.log 2>/dev/null || echo "No log file found"
    exit 1
  fi
  sleep 1
done

# Create database and user if they don't exist
echo "Setting up database..."
su postgres -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname = 'pinuy_admin'\" | grep -q 1" 2>/dev/null || {
  echo "Creating user pinuy_admin..."
  su postgres -c "psql -c \"CREATE USER pinuy_admin WITH PASSWORD 'pinuy_secure_2024' CREATEDB;\""
}

su postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname = 'pinuy_binuy'\" | grep -q 1" 2>/dev/null || {
  echo "Creating database pinuy_binuy..."
  su postgres -c "psql -c \"CREATE DATABASE pinuy_binuy OWNER pinuy_admin;\""
  su postgres -c "psql -d pinuy_binuy -c \"GRANT ALL PRIVILEGES ON SCHEMA public TO pinuy_admin;\""
}

# Set DATABASE_URL for the Node app (local connection, no SSL needed)
export DATABASE_URL="postgres://pinuy_admin:pinuy_secure_2024@localhost:5432/pinuy_binuy"
export DATABASE_SSL="false"

echo "DATABASE_URL set to localhost connection"
echo "Starting Node.js application..."
exec node src/index.js
