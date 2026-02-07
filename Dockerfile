FROM node:18-alpine

# Install PostgreSQL
RUN apk add --no-cache postgresql postgresql-contrib su-exec

# Create postgres user/group if not exists, set up data dir
RUN mkdir -p /var/lib/postgresql/data /run/postgresql \
    && chown -R postgres:postgres /var/lib/postgresql /run/postgresql

# Set working directory for Node app
WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application code
COPY . .

# Make startup script executable
RUN chmod +x start.sh

EXPOSE ${PORT:-3000}

CMD ["sh", "start.sh"]
