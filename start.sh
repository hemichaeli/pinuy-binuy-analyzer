#!/bin/bash
set -e

# Start PostgreSQL
echo "Starting PostgreSQL..."
su - postgres -c "pg_ctl -D /var/lib/postgresql/data -l /var/log/postgresql.log start" 2>/dev/null || true

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL..."
for i in $(seq 1 30); do
  if su - postgres -c "pg_isready" > /dev/null 2>&1; then
    echo "PostgreSQL is ready!"
    break
  fi
  sleep 1
done

# Create database and user if they don't exist
su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname = 'pinuy_binuy'\" | grep -q 1" 2>/dev/null || {
  echo "Creating database..."
  su - postgres -c "psql -c \"CREATE USER pinuy_admin WITH PASSWORD 'pinuy_secure_2024';\""
  su - postgres -c "psql -c \"CREATE DATABASE pinuy_binuy OWNER pinuy_admin;\""
  su - postgres -c "psql -c \"GRANT ALL PRIVILEGES ON DATABASE pinuy_binuy TO pinuy_admin;\""
}

# Set DATABASE_URL for the Node app (local connection)
export DATABASE_URL="postgresql://pinuy_admin:pinuy_secure_2024@localhost:5432/pinuy_binuy"
export DATABASE_SSL="false"

echo "Starting Node.js application..."
exec node src/index.js
