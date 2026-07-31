// ─── EIAAW POS shared types & DTOs (frontend + backend) ───────────────────────

export type Role = 'OWNER' | 'MANAGER' | 'CASHIER' | 'KITCHEN';

export type TenderType =
  | 'CASH'
  | 'DUITNOW_QR'
  | 'EWALLET_TNG'
  | 'EWALLET_GRABPAY'
  | 'EWALLET_BOOST'
  | 'CARD_TERMINAL'
  | 'CARD_MANUAL'
  | 'STRIPE'
  | 'ADYEN'
  | 'STORE_CREDIT';

export type OrderStatus = 'OPEN' | 'HELD' | 'COMPLETED' | 'VOIDED' | 'REFUNDED' | 'PARTIAL_REFUND';
export type PaymentStatus = 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'REFUNDED' | 'CANCELLED';
export type BusinessProfile = 'RETAIL' | 'FNB' | 'EVENTS' | 'SERVICES';
export type TaxCode = 'SST8' | 'SST6' | 'ZRL' | 'EXEMPT';
export type CashMovementType = 'CASH_IN' | 'CASH_OUT' | 'FLOAT' | 'DROP';

export interface CartLineDto {
  variantId: string;
  name: string;
  sku: string;
  qty: number;
  unitPrice: number; // in sen (integer money)
  discount: number; // in sen, per line total
  taxCode: string;
  taxAmount: number; // in sen
  notes?: string;
}

export interface CreateOrderDto {
  idempotencyKey: string; // client-generated UUID — offline-safe
  registerId: string;
  outletId: string;
  staffId?: string;
  customerId?: string;
  lines: CartLineDto[];
  cartDiscount: number; // sen
  roundingAdjustment: number; // sen (MY 5-sen cash rounding)
  payments: CreatePaymentDto[];
  placedAt: string; // ISO — when created on device (may predate sync)
  eventId?: string;
  offline?: boolean;
  /**
   * PIN of someone authorising a discount beyond the seller's own limit. Read
   * only when the sale actually demands more authority than the seller has, and
   * never stored — the order keeps the approver's id, not their credential.
   */
  discountApprovalPin?: string;
}

export interface CreatePaymentDto {
  tender: TenderType;
  amount: number; // sen
  reference?: string; // approval code / txn ref / last4
}

export interface OrderSummary {
  id: string;
  orderNo: string;
  status: OrderStatus;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  createdAt: string;
}

export interface DashboardStats {
  todaySales: number;
  todayOrders: number;
  avgTicket: number;
  tenderMix: { tender: string; amount: number }[];
  hourlySales: { hour: string; sales: number; orders: number }[];
  topProducts: { name: string; qty: number; sales: number }[];
  salesByDay: { date: string; sales: number }[];
}

export interface SyncBatchDto {
  registerId: string;
  orders: CreateOrderDto[];
}

export interface SyncResult {
  accepted: string[]; // idempotency keys
  duplicates: string[];
  failed: SyncFailure[];
}

export interface SyncFailure {
  key: string;
  reason: string;
  /**
   * True when replaying this order will fail identically forever — the server
   * refused it on its merits (unknown item, underpaid against the catalog
   * price) rather than being unable to answer. The terminal parks those for a
   * human instead of retrying them every ten seconds until the battery dies.
   */
  permanent: boolean;
}

export const MONEY = {
  /**
   * Format sen -> RM string. The sign leads the currency symbol so a refund
   * line reads "-RM 4.50" rather than "RM -4.50".
   */
  fmt(sen: number): string {
    return (sen < 0 ? '-' : '') + 'RM ' + (Math.abs(sen) / 100).toFixed(2);
  },

  /**
   * Bank Negara Malaysia 5-sen rounding adjustment for a cash total, in sen.
   * Applies to the cash tender only — card, DuitNow and e-wallet settle exact.
   *
   * Returns the adjustment to ADD, so `total + cashRounding(total)` is always
   * a multiple of 5 and never moves by more than 2 sen.
   *
   * Computed on the magnitude, then re-signed. Doing the modulo directly on a
   * negative total is wrong: JavaScript's `%` takes the sign of the dividend,
   * so -103 % 5 is -3, which the "round down" branch then pushes to -101
   * instead of -105 — a refund settling 4 sen short of the matching sale.
   */
  cashRounding(totalSen: number): number {
    const remainder = Math.abs(totalSen) % 5;
    if (remainder === 0) return 0;
    const adjustment = remainder < 3 ? -remainder : 5 - remainder;
    return totalSen < 0 ? -adjustment : adjustment;
  },
};

// ─── Tax ──────────────────────────────────────────────────────────────────────

/** Ceiling on a sane rate: 1000%. Anything past it is a data-entry accident. */
const MAX_RATE_BPS = 100_000;

export const TAX = {
  /**
   * The tax already contained in a tax-inclusive amount, in sen: the Malaysian
   * shelf price includes SST rather than adding it at the till, so the tax is
   * `gross * r / (1 + r)`, not `gross * r`. In basis points that is
   * `gross * bps / (10000 + bps)`, which keeps the whole calculation in
   * integers rather than trusting a float to land on a sen boundary.
   *
   * Rates arrive from the catalog rather than a table compiled in here: they
   * change on gazetted dates, and the rate that applied to a sale is a property
   * of when it happened, not of which build was deployed.
   *
   * Rounded on the magnitude and re-signed, so a refund reverses exactly the
   * sen the sale charged. `Math.round` alone breaks that symmetry at the .5
   * boundary — it rounds toward positive infinity, so a 33.5 sen sale charges
   * 34 and its own refund gives back 33, drifting TAX_PAYABLE by a sen a time.
   */
  inclusiveComponent(grossSen: number, rateBps: number): number {
    if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > MAX_RATE_BPS) {
      throw new Error(`Invalid tax rate ${rateBps} bps`);
    }
    if (rateBps === 0) return 0;
    const magnitude = Math.round((Math.abs(grossSen) * rateBps) / (10_000 + rateBps));
    return grossSen < 0 ? -magnitude : magnitude;
  },
};

export interface TaxCodeRate {
  code: string;
  name: string;
  rateBps: number;
}

// ─── Discount authority ───────────────────────────────────────────────────────

export interface DiscountPolicyDto {
  role: string;
  maxPercentBps: number;
  /** Null means no absolute ceiling. */
  maxAmountSen: number | null;
}

/** How much authority a sale is asking for. */
export interface DiscountDemand {
  /** The steepest discount anywhere in the sale, in basis points. */
  percentBps: number;
  /** Total taken off the sale, in sen. */
  totalSen: number;
}

/**
 * What a sale's discounts demand, measured two ways at once: the steepest
 * single line against its own price, and everything taken off against the cart.
 * The higher of the two governs, because both are ways to give money away and
 * neither should be reachable by hiding inside the other — half off one item in
 * a large basket is a half-off decision, however small it looks as a fraction
 * of the total.
 *
 * Lives here rather than on the server alone so the terminal can tell, before
 * it asks anyone for a PIN, whether this sale will need one. Two
 * implementations of this rule would drift, and the one that mattered would be
 * whichever was more permissive.
 */
export function discountDemand(
  lines: { gross: number; discount: number }[],
  cartDiscount: number,
): DiscountDemand {
  const subtotal = lines.reduce((s, l) => s + l.gross, 0);
  const totalSen = lines.reduce((s, l) => s + l.discount, 0) + cartDiscount;

  const pct = (part: number, whole: number) => {
    if (part <= 0) return 0;
    // Everything off something priced at nothing is still everything off.
    if (whole <= 0) return 10_000;
    return Math.round((part * 10_000) / whole);
  };

  const steepestLine = lines.reduce((worst, l) => Math.max(worst, pct(l.discount, l.gross)), 0);
  return { percentBps: Math.max(steepestLine, pct(totalSen, subtotal)), totalSen };
}

/**
 * Whether a role may take this discount unaided. A role with no policy at all
 * has no authority — an unrecognised role must not quietly inherit someone
 * else's — but nobody needs authority to discount nothing.
 */
export function policyAllows(policy: DiscountPolicyDto | undefined | null, demand: DiscountDemand): boolean {
  if (demand.percentBps <= 0 && demand.totalSen <= 0) return true;
  if (!policy) return false;
  if (demand.percentBps > policy.maxPercentBps) return false;
  return policy.maxAmountSen === null || demand.totalSen <= policy.maxAmountSen;
}

// ─── Trading day ──────────────────────────────────────────────────────────────

/**
 * The outlet's calendar date for an instant, as `YYYY-MM-DD`.
 *
 * The trading day belongs to the outlet, not to whatever timezone the server
 * container booted in. On a UTC host, a naive local-midnight boundary rolls
 * the Malaysian day over at 08:00 — mid-breakfast — so orders taken before
 * then are numbered into yesterday's sequence while carrying today's date
 * prefix. Formatting through `en-CA` yields ISO order directly, so the value
 * also sorts lexicographically.
 */
export function businessDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

// ─── Cash drawer ──────────────────────────────────────────────────────────────

/**
 * Which way each movement type moves the drawer. Cash movements are stored
 * already signed so that cash-up stays a plain `SUM(amount)`; without this,
 * summing unsigned rows makes a drop to the safe *increase* expected cash.
 */
export const CASH_MOVEMENT_SIGN: Readonly<Record<CashMovementType, 1 | -1>> = Object.freeze({
  CASH_IN: 1,
  FLOAT: 1,
  CASH_OUT: -1,
  DROP: -1,
});

/** Signed drawer delta for a movement. Takes a magnitude; direction is the type's. */
export function signedCashMovement(type: string, magnitudeSen: number): number {
  const sign = (CASH_MOVEMENT_SIGN as Record<string, 1 | -1>)[type];
  if (sign === undefined) throw new Error(`Unknown cash movement type "${type}"`);
  if (magnitudeSen < 0) {
    throw new Error(`Cash movement amount must be positive — direction comes from the type "${type}"`);
  }
  return sign * magnitudeSen;
}
