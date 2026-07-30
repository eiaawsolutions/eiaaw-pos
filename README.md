# EIAAW POS — AI-Native Point of Sale

Single-deployment-per-client POS platform by **EIAAW Solutions Sdn Bhd**.
Full blueprint: see `PRD-EIAAW-POS.md`.

## What's in this scaffold (v0.1)

| App | What it does |
|---|---|
| `apps/api` (NestJS + Prisma/PostgreSQL) | Auth/RBAC (JWT + terminal PIN), catalog + barcode scan resolution, orders with idempotent creation, inventory with movement trail, double-entry ledger, payments abstraction layer (cash + mock DuitNow/e-wallet/Stripe adapters + webhook sink), shifts & blind cash-up, X/Z + dashboard reports, offline sync endpoint, **AI auto-onboarding** (drop in event script + item docs → clarification-question loop → ready-to-sell catalog; zero-hallucination contract), MyInvois e-invoice queue |
| `apps/web` (Next.js) | POS terminal (product grid, keyboard-wedge barcode scanning, cart, cash w/ 5-sen rounding + change, DuitNow QR / e-wallet flow, manual card, 80mm receipt printing, **offline outbox** — keeps selling with no network), live interactive dashboard (Recharts, 15s auto-refresh), AI Import page |
| `apps/worker` | Background jobs: MyInvois submitter (stub), hourly sales rollups |
| `packages/shared` | Types/DTOs + money utils shared FE/BE |

## Run locally

```bash
npm install
cp .env.example .env                      # then fill in the values below
docker compose -f docker-compose.dev.yml up -d   # postgres + redis
npm run build -w packages/shared
npx -w apps/api prisma db push            # create schema
npm run db:seed                           # demo outlet, users, products
npm run dev:api                           # :3001
npm run dev:web                           # :3000  (new terminal)
npm run dev:worker                        # optional
```

Login: `admin@eiaawsolutions.com` / `ChangeMe123!` (terminal PIN `123456`).

**Port conflicts.** Postgres and Redis default to 5432/6379. If another project
on your machine already holds those, set `POSTGRES_PORT` / `REDIS_PORT` in `.env`
before `docker compose up`, and make `DATABASE_URL` and `REDIS_URL` agree — the
compose file reads them.

## Deploy to Railway (per client)

1. Create a Railway project → add **PostgreSQL** (and **Redis** for event scale).
2. Add three services from this repo (GitHub or `railway up`), each using its Dockerfile with **root as build context**:
   - `api` → `apps/api/Dockerfile` — vars: `DATABASE_URL` (reference the Postgres plugin), `JWT_SECRET`, `WEB_ORIGIN=https://<web-domain>`, `ANTHROPIC_API_KEY`
   - `worker` → `apps/worker/Dockerfile` — vars: `DATABASE_URL`
   - `web` → `apps/web/Dockerfile` — build arg/var: `NEXT_PUBLIC_API_URL=https://<api-domain>`
3. Generate public domains for `api` and `web`. The api service syncs the DB schema automatically on boot (`prisma db push`).
4. Seed once: `railway run npm run db:seed` (against the api service).
5. For sales events: scale `api`/`worker` replicas up in Railway before doors open.

## Hardware

- **Scanners**: any USB/Bluetooth keyboard-wedge 1D/2D scanner works out of the box on the terminal page (scan anywhere — no field focus needed).
- **Printers**: browser 80mm receipt printing works today; `apps/web/src/lib/print.ts` already builds raw ESC/POS bytes (incl. cash-drawer kick) for the v1.0 Print Bridge / WebUSB path (Epson TM, Xprinter, Sunmi/iMin).

## AI auto-onboarding — zero-hallucination contract

`POST /api/ai/onboarding/sessions` with raw document text (event script, barcode/price lists) → extraction (Anthropic API; deterministic parser fallback without a key) → every missing/ambiguous field becomes a **clarification question** → `POST .../answers` → repeat until `READY` → `POST .../commit` puts items live. The commit endpoint structurally refuses while any question is open — the system cannot sell an assumed price or invented barcode.
