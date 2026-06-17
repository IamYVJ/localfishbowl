# syntax=docker/dockerfile:1
# ============================================================================
# Fishbowl authoritative server image.
# Built for linux/arm64 in GitHub Actions (see .github/workflows/server.yml),
# pulled and run on the Raspberry Pi. NEVER built on the Pi itself.
#
# Build context is the REPO ROOT (so the shared engine in js/ is reachable):
#   docker build -f server/Dockerfile -t fishbowl-server .
# ============================================================================

# ---- deps: install production node_modules in isolation --------------------
FROM node:20-alpine AS deps
WORKDIR /app/server
# Copy the manifest AND the committed lockfile so `npm ci` is fully reproducible.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime ---------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ARG APP_VERSION=dev
ENV NODE_ENV=production
ENV PORT=9000
ENV APP_VERSION=${APP_VERSION}

# Shared game engine — ONLY the two modules the server actually imports.
# (Fishbowl has no stats module, unlike Avalon.)
COPY js/state.js js/rules.js ./js/
# Server source.
COPY server ./server
# Production dependencies from the deps stage.
COPY --from=deps /app/server/node_modules ./server/node_modules

EXPOSE 9000
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:9000/health || exit 1

CMD ["node", "server/index.js"]
