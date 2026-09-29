# Production image for the external VPS Compose deployment.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS builder

WORKDIR /app

# better-sqlite3 is native code and needs the Linux build toolchain during npm ci.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends --yes wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node views/ ./views/
COPY --chown=node:node public/ ./public/

RUN mkdir -p /app/data \
    && chown node:node /app/data

ENV NODE_ENV=production \
    TAPBOARD_HOST=0.0.0.0 \
    PORT=3005 \
    DATA_DIR=/app/data

USER node

EXPOSE 3005
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 CMD wget --no-verbose --tries=1 --spider "http://localhost:${TAPBOARD_PORT:-${PORT:-3005}}/healthz"

CMD ["node", "src/main.ts"]
