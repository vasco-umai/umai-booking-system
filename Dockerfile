FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better Docker cache)
COPY package*.json ./
RUN npm ci --production

# Copy application code
COPY server/ ./server/
COPY frontend/ ./frontend/

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "server/src/index.js"]
