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

/**
 * Statutory rates for the tax codes the catalog may carry. Shared by the
 * terminal and the pricing authority on the server so both arrive at the same
 * sen — a client that computed tax differently would trip the re-pricing
 * mismatch audit on every single sale.
 *
 * These are compiled in rather than configured because a rate change is never
 * just a number: it lands on a gazetted date and usually re-prices the catalog
 * with it. Changing them is a deploy, deliberately.
 */
export const TAX_RATES: Readonly<Record<TaxCode, number>> = Object.freeze({
  SST8: 0.08,
  SST6: 0.06,
  ZRL: 0,
  EXEMPT: 0,
});

export const TAX = {
  /**
   * Rate for a code. Throws on anything unrecognised: a mis-configured product
   * must fail loudly at the counter, because the quiet alternative — treating
   * it as zero-rated — under-declares SST on every sale of that item and
   * leaves no trace to find it by.
   */
  rate(code: string): number {
    const rate = (TAX_RATES as Record<string, number>)[code];
    if (rate === undefined) throw new Error(`Unknown tax code "${code}"`);
    return rate;
  },

  /**
   * The tax already contained in a tax-inclusive amount, in sen: the Malaysian
   * shelf price includes SST rather than adding it at the till, so the tax is
   * `gross * r / (1 + r)`, not `gross * r`.
   *
   * Rounded on the magnitude and re-signed, so a refund reverses exactly the
   * sen the sale charged. `Math.round` alone breaks that symmetry at the .5
   * boundary — it rounds toward positive infinity, so a 33.5 sen sale charges
   * 34 and its own refund gives back 33, drifting TAX_PAYABLE by a sen a time.
   */
  inclusiveComponent(grossSen: number, code: string): number {
    const rate = TAX.rate(code);
    if (!rate) return 0;
    const magnitude = Math.round((Math.abs(grossSen) * rate) / (1 + rate));
    return grossSen < 0 ? -magnitude : magnitude;
  },
};

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
