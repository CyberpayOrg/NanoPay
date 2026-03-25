# CyberNanoPay TEE — Phala Cloud CVM Deployment
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-slim
WORKDIR /app

# better-sqlite3 needs these
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist dist/

# Persistent data directory (mount a volume here)
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/gateway.db

EXPOSE 4030
CMD ["node", "dist/server.js"]
