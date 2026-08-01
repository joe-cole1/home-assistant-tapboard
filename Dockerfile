# Step 1: Build Dependencies Stage
FROM node:22-alpine@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++ gcc

COPY package*.json ./
RUN npm ci --omit=dev

# Step 2: Lightweight Production Stage
FROM node:22-alpine@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV BACKUP_DIR=/app/backups

# Copy production dependencies and application code
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node scripts/ ./scripts/

# Named volumes copy these ownership bits on first use. The image itself stays
# read-only at runtime; only these mount points and /tmp are writable.
RUN mkdir -p /app/data /app/backups \
  && chown node:node /app/data /app/backups

EXPOSE 3000

USER node

CMD ["node", "src/server.js"]
