# EIAAW POS worker — build from the repository root:
#   docker build -f apps/worker/Dockerfile .
#
# The worker has no HTTP surface; it polls the database for queued e-invoices
# and rebuilds the hourly sales rollups. It needs the Prisma client, and the
# schema lives in apps/api.

# ─── dependencies (with dev, for the build) ──────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
# Present before install — the root postinstall generates the client from it.
COPY apps/api/prisma apps/api/prisma
RUN npm ci

# ─── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN npm run build -w packages/shared && npm run build -w apps/worker

# ─── production dependencies only ────────────────────────────────────────────
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/api/prisma apps/api/prisma
# Scoped — see the note in apps/api/Dockerfile. The worker needs even less: no
# Nest, no HTTP stack.
RUN npm ci --omit=dev -w @eiaaw/worker -w @eiaaw/shared --include-workspace-root

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json

USER node

# No healthcheck: nothing listens. Liveness is inferred from the rollup
# freshness the worker maintains — an alert on stale SalesRollupHourly buckets
# is the real signal, and belongs in the deployment target's monitoring.
CMD ["node", "apps/worker/dist/index.js"]
