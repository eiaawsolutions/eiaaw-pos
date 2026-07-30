# EIAAW POS API — build from the repository root:
#   docker build -f apps/api/Dockerfile .
#
# Four stages so the runtime image carries production dependencies and compiled
# output only — no source, no devDependencies, no toolchain.

# ─── dependencies (with dev, for the build) ──────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
# The schema must be present before install: the root postinstall runs
# `prisma generate` against it.
COPY apps/api/prisma apps/api/prisma
# `npm ci` not `npm install` — installs exactly the locked tree and fails if
# package.json and the lockfile have drifted.
RUN npm ci

# ─── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w packages/shared && npm run build -w apps/api

# ─── production dependencies only ────────────────────────────────────────────
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/api/prisma apps/api/prisma
# Scoped to this service's workspaces. A bare `npm ci --omit=dev` at the root
# installs every workspace's production dependencies, which put Next, React,
# Recharts and sharp — 420MB — into an image that never renders anything.
RUN npm ci --omit=dev -w @eiaaw/api -w @eiaaw/shared --include-workspace-root

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prisma's CLI needs it at boot for the schema sync below; wget backs the
# healthcheck. Both are dropped once migrations replace the boot-time push.
RUN apk add --no-cache openssl wget

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/prisma ./apps/api/prisma

# The node image ships an unprivileged `node` user; root is not needed to
# listen on 3001.
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1

# TODO(schema): `db push` on boot races when the service runs more than one
# replica — which the event-scale path requires — and is destructive against a
# drifted production database. It stays only because no migrations exist yet.
# Replace with `prisma migrate deploy` as a release step once they do.
CMD ["sh", "-c", "npx prisma db push --schema apps/api/prisma/schema.prisma --skip-generate && node apps/api/dist/main.js"]
