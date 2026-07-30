# EIAAW POS — Product Requirements Document & Technical Blueprint

**Product:** EIAAW POS — AI-Native Point of Sale Platform
**Owner:** EIAAW Solutions Sdn Bhd (202603133419 / CT0164540-H)
**Version:** 1.0 · 30 July 2026
**Deployment model:** Single deployment per client (dedicated Railway project per client)
**Primary market:** Malaysia / APAC · Global-capable

---

## 1. Executive Summary

EIAAW POS is an AI-native, cloud point-of-sale platform delivering full parity with modern POS incumbents (Square, Lightspeed, StoreHub, Qashier, Loyverse) plus an AI layer none of them ship as standard. It is built to survive **high-volume sales events** (concerts, expos, warehouse sales, festival bazaars, stadium F&B) through an offline-first terminal, queue-based order pipeline, and horizontally scalable services on Railway.

Differentiators:

1. **AI-native, not AI-bolted-on** — forecasting, dynamic pricing suggestions, anomaly/fraud detection, natural-language analytics, and an in-terminal AI assistant are first-class modules.
2. **Event Mode** — a purpose-built high-throughput configuration: offline queue, simplified catalogs, pre-authorized floats, burst-scaled infrastructure.
3. **Malaysia-correct from day one** — DuitNow QR, e-wallets (TNG/GrabPay/Boost), SST, LHDN MyInvois e-Invoice, PDPA.
4. **Industry packs** — retail, F&B, events, and services profiles switch on vertical-specific workflows (KDS/tables for F&B, ticket/wristband redemption for events, appointments for services).

---

## 2. Deployment & Commercial Model

- **Single-tenant per client**: each client gets a dedicated Railway project (isolated Postgres, Redis, services). No noisy-neighbor risk; per-client customization is safe; data residency questions are trivial to answer.
- A shared **EIAAW control plane** (later phase) can manage fleet upgrades via Railway API + templated deployments (Railway Template → one-click client provisioning).
- Licensing: annual license + per-terminal fee + payments margin (where EIAAW is the referral partner of the PSP).

---

## 3. Target Industries & Profiles

| Profile | Verticals | Profile-specific features |
|---|---|---|
| Retail | fashion, electronics, grocery, pharmacy-adjacent | variants/matrix SKUs, GS1 barcodes, stock takes, purchase orders, supplier mgmt |
| F&B | cafés, restaurants, food courts, cloud kitchens | table map, kitchen display (KDS), modifiers, split bills, service charge, open tabs |
| Events | concerts, expos, bazaars, stadiums, pop-ups | Event Mode, cashless wristband/QR wallets, multi-booth settlement, per-vendor payout reports |
| Services | salons, clinics-adjacent (non-medical), repairs | appointments, deposits, packages/sessions, commission tracking |

One codebase; profiles are configuration + feature flags, not forks.

---

## 4. Functional Modules (POS parity checklist)

### 4.1 Sell / Checkout
- Product grid + search + barcode/QR scan-to-cart; weighted/priced-embedded barcodes (GS1 prefix rules)
- Cart: line discounts, cart discounts, price override (permission-gated), notes, tax-inclusive/exclusive pricing
- Held/parked sales, open tabs, split payment, split bill (F&B), partial refunds, exchanges
- Offline-first: terminal continues selling with no network; orders queue and sync with conflict-safe idempotency keys
- Receipts: printed (ESC/POS), e-receipt (WhatsApp/email/QR link), MyInvois-compliant invoice on request

### 4.2 Catalog & Pricing
- Product → variant (SKU) → barcode (GTIN/EAN/UPC + internal codes); composite/bundle products; modifiers (F&B)
- Multi-price lists (outlet, channel, member tier), scheduled promotions, happy hour, mix-and-match, buy-X-get-Y
- Cost tracking (moving average), margin visibility, SST tax codes per item, halal/category flags

### 4.3 Inventory
- Real-time stock by outlet/location; reservations at order time (single source of truth — prevents overselling)
- Stock takes (full/partial, blind counts), transfers between outlets, adjustments with reason codes
- Purchase orders → GRN → supplier invoices; low-stock alerts; batch/expiry (grocery/F&B)

### 4.4 Customers & Loyalty
- CRM-lite: profiles, purchase history, tags, PDPA consent tracking
- Points engine (accrual rules, tiers, expiry), store credit, vouchers, birthday campaigns
- Hook into EIAAW AI Sales Agent / SMT for lifecycle marketing (existing EIAAW products)

### 4.5 Staff, Shifts & Cash Management
- PIN/RFID login per staff on shared terminals; role-based permissions (void, refund, price override, discount cap)
- Shift open/close, cash float, cash in/out, blind cash-up, over/short reporting
- Attendance stamps, commission rules (services profile)

### 4.6 Payments (see §7)
### 4.7 Tax & Compliance (Malaysia)
- SST (sales tax & service tax) with item-level tax codes; tax-inclusive display per BNM/consumer norms
- **LHDN MyInvois e-Invoice**: consolidated e-invoice for B2C (monthly), on-demand full e-invoice with buyer TIN validation, real-time API submission with offline queue and 72-hour rules honored
- PDPA: consent capture, data export/delete workflows, audit logs

### 4.8 Returns/Refunds & Disputes
- Same-tender refund enforcement, manager approval thresholds, restocking flags, refund-to-store-credit

### 4.9 Multi-Outlet
- Outlet hierarchy, per-outlet pricing/tax/receipt config, centralized catalog with local overrides, consolidated + per-outlet reporting

---

## 5. Event Mode (high-volume sales events)

The flagship capability. Activated per outlet or per "event" entity:

- **Offline-first terminals**: full catalog cached (IndexedDB); orders written locally first, synced via idempotent batch API. Target: terminal keeps selling for hours with zero connectivity.
- **Throughput architecture**: order ingestion goes to Redis-backed queue (BullMQ); workers post to ledger/inventory asynchronously. API stays thin and horizontally scaled (Railway replicas + autoscaling).
- **Simplified event catalogs**: flat, big-button catalogs (≤48 items) for speed; price-embedded quick keys.
- **Cashless event wallets** (phase 2): QR wristband top-up wallets; sub-100ms local debit at booth, settled centrally.
- **Multi-vendor events**: booth = sub-merchant; per-vendor Z-reports and settlement statements for organizer payouts.
- **Ops dashboard**: live sales/min, queue depth, terminal heartbeat map, top SKUs, cash-vs-cashless mix — refreshed via WebSocket.
- **Performance targets**: 200+ orders/min sustained per event, <150ms p95 order accept (online), <2s from scan to paid (cash path).

---

## 6. AI Use-Case Catalog

| # | Use case | Where it lives | How |
|---|---|---|---|
| 1 | **Natural-language analytics** ("berapa sales semalam vs minggu lepas?") | Back-office + WhatsApp | LLM → guarded SQL templates over reporting views; answers with chart + narrative |
| 2 | **Demand forecasting** | Inventory | Time-series per SKU/outlet (seasonality, events, weather, MY public holidays) → reorder suggestions, PO drafts |
| 3 | **Dynamic pricing & markdown suggestions** | Pricing | Margin + velocity + expiry-aware suggestions; human-approve, never auto-apply by default |
| 4 | **Fraud & anomaly detection** | Payments/Staff | Void/refund abuse patterns, sweethearting, unusual discount concentration per staff; real-time alerts |
| 5 | **Smart upsell at checkout** | Terminal | Basket-based next-item suggestion (association rules + embeddings); one-tap add |
| 6 | **AI receipt/label intelligence** | Catalog | Photo of supplier invoice/product → auto-create SKUs, extract cost prices (vision model) |
| 7 | **Shift & staffing forecast** | Staff | Predicted footfall → suggested rostering; event-day staffing planner |
| 8 | **End-of-day AI summary** | Reports | Auto-generated daily digest (what sold, anomalies, actions) pushed to WhatsApp/email |
| 9 | **In-terminal AI assistant** | Terminal | "How do I do a split bill?" / policy Q&A — grounded on client's own SOP docs |
| 10 | **Customer churn & LTV scoring** | CRM/Loyalty | Feeds EIAAW AI Sales Agent for win-back campaigns |
| 11 | **Voice ordering assist (F&B)** (phase 3) | Terminal/KDS | Speech → structured order draft for cashier confirmation |
| 12 | **Event demand curve prediction** | Event Mode | Pre-event stock and float planning from ticket sales/attendance data |

### 6.1 AI Auto-Onboarding — zero-hallucination catalog ingest (flagship)

The user drops in the **event script** and **item documents** (barcode/QR lists, price sheets, CSVs, photos in v1.0) and the system auto-configures the catalog up to ready-to-sell:

1. **Extract** — AI reads the documents and pulls out items (name, SKU, barcode/QR, price, category, quantities) plus event context (dates, booths, expected volume). Every extracted value carries the source-text evidence it came from.
2. **Clarify — never assume** — a hard contract: a field is either *explicitly stated* in the documents or it becomes a **clarification question** tied to the specific item ("For 'Tote Bag, 9551000000222': what is the price? — not stated in the document"). Conflicts (duplicate barcodes, two prices for one item) also become questions. The system is structurally incapable of guessing: prices are never inferred, barcodes never constructed.
3. **Iterate** — the user answers the question series; answers are treated as ground truth and re-checked until zero questions remain.
4. **Commit** — only at zero open questions does the "Commit — ready to sell" action unlock; items, barcodes, categories, and stock levels go live on the terminals instantly. The commit endpoint refuses otherwise — enforcement is in code, not in the prompt.

*(Implemented in the v0.1 scaffold: `/import` page + `ai/onboarding` API module with session → questions → answers → commit flow; Anthropic-powered extraction with a deterministic parser fallback.)*

AI runtime: Anthropic Claude API for language/vision/reasoning use cases; classical stats (Prophet-style/ETS) for forecasting; all AI outputs are **suggestions with human approval** where money or price is affected. Guardrails: SQL allow-list, PII redaction before prompts, per-client model config.

---

## 7. Payments Architecture

**Principle:** EIAAW POS never touches PAN. Card present = terminal-based (PCI scope stays with acquirer, SAQ-A posture). All money movement flows through a **provider-agnostic Payments Abstraction Layer (PAL)** with idempotency keys and a **double-entry ledger**.

| Rail | v1 Provider strategy |
|---|---|
| **DuitNow QR** (dynamic QR per order) | Via local PSP/aggregator — recommended: **Fiuu (formerly Razer Merchant Services)** or **eGHL** or **Revenue Monster**; one integration covers DuitNow + wallets |
| **E-wallets** (TNG, GrabPay, Boost, ShopeePay) | Same aggregator as above (single contract, single recon file) |
| **Card terminals** | v1: semi-integrated via aggregator terminal APIs where available; fallback **record-only manual card** entry (amount + last-4 + approval code) |
| **Cash** | Full drawer management, float, denominations, over/short |
| **Global rails** | **Stripe** (Terminal + PaymentIntents) and **Adyen** adapter for cross-border clients |
| **Refunds** | Rail-native where supported; store-credit fallback |

- **Ledger**: append-only double-entry (sale, tender, fee, payout, refund, chargeback); reconciliation engine matches PSP settlement files to ledger daily.
- **Webhooks**: signed, retried, replay-protected.
- Split-tender, tips/service charge, rounding to 5 sen (MY cash rounding rule).

---

## 8. Hardware Integration

| Device | Integration path |
|---|---|
| **Barcode/QR scanners (USB/BT)** | Keyboard-wedge capture (universal, zero-driver) + WebHID for advanced control; works with Zebra, Honeywell, Netum, generic 1D/2D |
| **Camera scanning** | Browser camera via native BarcodeDetector API + ZXing fallback — tablets/phones become scanners |
| **Receipt printers (ESC/POS)** | Three paths: (1) **Network/LAN printers** direct from local Print Bridge, (2) **WebUSB** direct from browser terminal, (3) **EIAAW Print Bridge** — a tiny cross-platform agent (Node/Go) on the station that discovers USB/LAN printers and exposes localhost print API. Supports Epson TM series, Xprinter, iMin, Sunmi built-ins |
| **Cash drawers** | RJ11 kick pulse via printer (standard ESC/POS drawer-kick command) |
| **Label printers** | ESC/POS + TSPL (product/shelf labels with barcodes) |
| **Customer display / QR display** | Second screen route (`/display`) showing cart + dynamic DuitNow QR |
| **KDS screens (F&B)** | Any browser device on `/kds` with WebSocket order feed |
| **Android POS all-in-ones (Sunmi/iMin)** | PWA runs natively; built-in printer via their bridge SDKs (phase 2 native wrapper) |

---

## 9. Reporting & Interactive Dashboards

- **Live dashboard**: today's sales, orders/hour, ATV, tender mix, top products/categories, per-outlet comparison — WebSocket-refreshed.
- **Standard reports**: X/Z reports, sales by product/category/staff/outlet/hour/day, tender & settlement, tax (SST) report, inventory valuation, stock movement, margin, refunds/voids audit, shift/cash-up history, loyalty liability.
- **Interactive**: date-range + outlet + channel filters, drill-down (category → product → transactions), CSV/XLSX export, scheduled email/WhatsApp digests.
- **Event ops dashboard** (§5) and **AI daily digest** (§6.8).
- Implementation: pre-aggregated reporting tables (hourly rollups via worker) so dashboards stay fast at event volume; Recharts front-end; every chart queryable via the NL-analytics AI.

---

## 10. Technical Architecture (Railway-optimized)

**Stack: TypeScript end-to-end** — the best fit for Railway (first-class Node buildpacks/Dockerfiles, cheap horizontal replicas, native WebSocket support, one language across API/terminal/bridge).

```
Railway Project (per client)
├── web        Next.js 14 (App Router) — POS terminal PWA, back-office, KDS, customer display
├── api        NestJS — REST + WebSocket gateway, Prisma ORM, JWT/RBAC
├── worker     BullMQ consumers — order pipeline, rollups, MyInvois submits, webhooks, AI jobs
├── postgres   Railway PostgreSQL (single source of truth)
└── redis      Railway Redis (queues, cache, pub/sub for live dashboards)
```

- **Monorepo**: npm workspaces — `apps/web`, `apps/api`, `apps/worker`, `packages/shared` (types/DTOs shared FE/BE).
- **Offline-first terminal**: PWA + IndexedDB (Dexie) order outbox → idempotent `/sync` batch endpoint.
- **Scaling for events**: Railway replicas on `api` + `worker`; queue absorbs bursts; Postgres protected by async posting.
- **Observability**: structured logs, health endpoints, Sentry; terminal heartbeat telemetry.
- **Security**: JWT short-lived + refresh, RBAC, per-terminal device registration, audit log on every money-affecting action, TLS everywhere, secrets in Railway variables, PDPA data workflows.
- **Backups**: Railway Postgres backups + nightly logical dump to client-owned object storage.

### Core data model (Prisma)
`Outlet, Register(Terminal), User(Staff), Role, Product, Variant(SKU), Barcode, Category, Modifier, PriceList, TaxCode, InventoryLevel, StockMovement, PurchaseOrder, Supplier, Customer, LoyaltyAccount, LoyaltyTransaction, Order, OrderLine, Payment, Refund, LedgerEntry, Shift, CashMovement, Promotion, Event, Booth, EInvoice, AuditLog, Device, PrintJob`

---

## 11. Non-Functional Requirements

- p95 API < 150ms (order accept); terminal interactions < 100ms perceived (local-first)
- 99.9% platform availability; terminal sells offline at 100% availability regardless
- Event burst: 200 orders/min sustained, 500/min peak per deployment
- PDPA compliant; PCI scope SAQ-A (no PAN storage — enforced architecturally)
- RTO 4h / RPO 24h minimum (v1), improving with WAL archiving (v2)

---

## 12. Roadmap

| Phase | Scope |
|---|---|
| **v0.1 (this scaffold)** | Monorepo, auth/RBAC, catalog, cart/checkout, cash + mock rail payments, PAL interfaces, inventory, offline outbox, ESC/POS printing paths, reports API + interactive dashboard, AI auto-onboarding (§6.1), seed data, Railway deploy config |
| **v1.0 (MVP, ~8–10 wks)** | Fiuu/eGHL DuitNow+wallet live integration, Stripe adapter, MyInvois integration, loyalty, promotions engine, shifts/cash-up complete, Print Bridge agent, F&B pack (KDS/tables) |
| **v1.5** | Event Mode complete (multi-vendor, ops dashboard, wristband wallets pilot), AI use cases 1–5 + 8, Adyen |
| **v2.0** | Services pack, purchase-to-pay, AI 6–10, control-plane fleet provisioning via Railway templates, Sunmi/iMin native wrappers |

---

## 13. What Claude can do vs. what Amos must do

**Claude (in Cowork sessions):** full codebase build-out phase by phase, Prisma schema + migrations, all module implementation, dashboard/UI build, AI feature implementation against Anthropic API, MyInvois/PSP adapter code from their API docs, test suites, Railway config, deployment docs, client onboarding runbooks.

**Amos personally:** Railway account/projects + billing; PSP merchant applications (Fiuu/eGHL/Revenue Monster require SSM docs + bank account — 1–3 weeks lead time, start early); Stripe/Adyen account KYB; LHDN MyInvois taxpayer credentials + client TINs; buying test hardware (recommend: 1× Xprinter 80mm LAN ESC/POS ~RM250, 1× Netum 2D USB scanner ~RM120, cash drawer RJ11 ~RM180); domain/DNS (Cloudflare); signing client contracts and PDPA notices; deciding per-client pricing.
