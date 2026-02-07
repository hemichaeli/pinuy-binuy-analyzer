FROM node:18-bookworm

# Install PostgreSQL 16
RUN apt-get update && \
    apt-get install -y gnupg2 lsb-release wget && \
    echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add - && \
    apt-get update && \
    apt-get install -y postgresql-16 && \
    rm -rf /var/lib/apt/lists/*

# Initialize PostgreSQL database
USER postgres
RUN /usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/data && \
    echo "host all all 0.0.0.0/0 md5" >> /var/lib/postgresql/data/pg_hba.conf && \
    echo "listen_addresses='*'" >> /var/lib/postgresql/data/postgresql.conf

USER root

# Set up Node.js app
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

# Make startup script executable
RUN chmod +x start.sh

# Expose the app port
EXPOSE ${PORT:-3000}

CMD ["bash", "start.sh"]
