FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

EXPOSE ${PORT:-3000}

CMD ["node", "src/index.js"]
