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
  failed: { key: string; reason: string }[];
}

export const MONEY = {
  /** Format sen -> RM string */
  fmt(sen: number): string {
    return 'RM ' + (sen / 100).toFixed(2);
  },
  /** Malaysian 5-sen cash rounding adjustment for a total in sen */
  cashRounding(totalSen: number): number {
    const r = totalSen % 5;
    if (r === 0) return 0;
    return r < 3 ? -r : 5 - r;
  },
};
