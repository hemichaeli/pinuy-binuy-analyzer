FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE ${PORT:-3000}

CMD ["node", "src/index.js"]
