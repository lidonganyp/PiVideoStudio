# ========== Stage 1: ffmpeg static build ==========
FROM jrottenberg/ffmpeg:4.4-alpine AS ffmpeg-builder

# ========== Stage 2: build app ==========
FROM node:22-alpine AS app-builder

RUN apk add --no-cache python3 make g++ \
    && corepack enable

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./

# Copy all package.json files for install
COPY api/package.json api/
COPY runtime/package.json runtime/
COPY web/package.json web/

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source code
COPY . .

# Build all packages
RUN pnpm -r build

# ========== Stage 3: production ==========
FROM node:22-alpine AS production

# Install ffmpeg from alpine repo (statically linked)
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./

# Copy built packages
COPY --from=app-builder /app/api/package.json api/
COPY --from=app-builder /app/api/dist api/dist
COPY --from=app-builder /app/runtime/package.json runtime/
COPY --from=app-builder /app/runtime/dist runtime/dist
COPY --from=app-builder /app/web/package.json web/
COPY --from=app-builder /app/web/dist web/dist

# Install production dependencies only
RUN corepack enable \
    && pnpm install --prod --frozen-lockfile || pnpm install --prod

# Create storage directory
RUN mkdir -p /app/storage

# Environment defaults
ENV NODE_ENV=production
ENV PIVIDEO_DB_PATH=/app/storage/pivideo.db
ENV PORT=3100

# Expose API port
EXPOSE 3100

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3100/api/health || exit 1

CMD ["node", "api/dist/index.js"]
