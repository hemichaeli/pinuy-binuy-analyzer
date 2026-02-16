# Railway Dockerfile with Chromium for Puppeteer v4.8.5
# Using full node:18 (not slim) for better Chromium compatibility
FROM node:18-bookworm

# Install Chromium and all required dependencies
# Using chromium package from Debian Bookworm repos
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       chromium \
       fonts-liberation \
       fonts-noto-color-emoji \
       fonts-noto-cjk \
       libatk-bridge2.0-0 \
       libatk1.0-0 \
       libcups2 \
       libdrm2 \
       libgbm1 \
       libgtk-3-0 \
       libnspr4 \
       libnss3 \
       libx11-xcb1 \
       libxcomposite1 \
       libxdamage1 \
       libxfixes3 \
       libxrandr2 \
       libxshmfence1 \
       xdg-utils \
    && rm -rf /var/lib/apt/lists/* \
    && chromium --version

# Verify Chromium is installed and set paths
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium

# Create app directory
WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install dependencies (production only to save space)
RUN npm install --omit=dev

# Copy application code
COPY . .

# Build-time patches (v4.24.2): fix column names in weeklyScanner kones query
RUN sed -i "s/SELECT id, name, city, street, address FROM complexes/SELECT id, name, city, neighborhood, addresses FROM complexes/" src/jobs/weeklyScanner.js

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["npm", "start"]
