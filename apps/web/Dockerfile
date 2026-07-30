# EIAAW POS web — build from the repository root:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example .
#
# NEXT_PUBLIC_* is inlined into the client bundle at build time, so the API URL
# is baked into the image. Under the one-deployment-per-client model that is
# acceptable — each client gets their own image — but it does mean an image is
# not portable between clients. Changing the API host requires a rebuild.

# ─── dependencies ────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
# Present before install — the root postinstall generates the Prisma client.
# The web app does not use it, but the install is workspace-wide.
COPY apps/api/prisma apps/api/prisma
RUN npm ci

# ─── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w packages/shared && npm run build -w apps/web

# ─── runtime ─────────────────────────────────────────────────────────────────
# `output: 'standalone'` in next.config.js emits a self-contained server with
# only the modules it actually traced, so no node_modules copy is needed.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apk add --no-cache wget

COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1

CMD ["node", "apps/web/server.js"]
