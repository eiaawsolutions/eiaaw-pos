# EIAAW POS API — build from repo root: docker build -f apps/api/Dockerfile .
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm install --workspaces --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w packages/shared && npm run build -w apps/api

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3001
# Sync schema on boot (switch to `prisma migrate deploy` once migrations are adopted in v1.0)
CMD ["sh", "-c", "npx -w apps/api prisma db push --skip-generate && node apps/api/dist/main.js"]
