# EIAAW POS worker — build from repo root: docker build -f apps/worker/Dockerfile .
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN npm install --workspaces --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/worker apps/worker
# Generate prisma client (schema lives in apps/api), then build worker
RUN npx -w apps/api prisma generate && npm run build -w packages/shared && npm run build -w apps/worker

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
CMD ["node", "apps/worker/dist/index.js"]
