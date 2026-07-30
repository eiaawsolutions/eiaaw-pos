'use client';

/**
 * Offline-first order outbox. Orders are ALWAYS written locally first, then
 * synced. If the network is down (mid-event), selling continues; the outbox
 * drains automatically when connectivity returns. Idempotency keys make
 * retries safe server-side.
 */
import type { CreateOrderDto, SyncResult } from '@eiaaw/shared';
import { api } from './api';

const KEY = 'eiaaw_outbox_v1';
const REJECTED_KEY = 'eiaaw_outbox_rejected_v1';

export interface RejectedOrder {
  order: CreateOrderDto;
  reason: string;
  rejectedAt: string;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function read(): CreateOrderDto[] {
  return readJson<CreateOrderDto[]>(KEY, []);
}

function write(orders: CreateOrderDto[]) {
  localStorage.setItem(KEY, JSON.stringify(orders));
}

export function enqueue(order: CreateOrderDto) {
  write([...read(), order]);
}

export function pendingCount(): number {
  return read().length;
}

/**
 * Orders the server refused outright — a stale cached price, an item pulled
 * from the catalog. They are parked rather than retried, and rather than
 * dropped: the customer walked away with a printed receipt, so somebody has to
 * reconcile each one by hand.
 */
export function rejected(): RejectedOrder[] {
  return readJson<RejectedOrder[]>(REJECTED_KEY, []);
}

export function rejectedCount(): number {
  return rejected().length;
}

export function clearRejected() {
  localStorage.removeItem(REJECTED_KEY);
}

export async function drain(registerId: string): Promise<SyncResult | null> {
  const orders = read();
  if (!orders.length) return null;
  const result = await api<SyncResult>('/sync/orders', {
    method: 'POST',
    body: JSON.stringify({ registerId, orders }),
  });

  // A permanent refusal will refuse identically on the next tick and the one
  // after, so it leaves the queue — otherwise one bad order blocks nothing but
  // burns a request every ten seconds and quietly never syncs.
  const refused = new Map(result.failed.filter((f) => f.permanent).map((f) => [f.key, f.reason]));
  if (refused.size) {
    const parked = orders
      .filter((o) => refused.has(o.idempotencyKey))
      .map((order) => ({
        order,
        reason: refused.get(order.idempotencyKey) ?? 'refused',
        rejectedAt: new Date().toISOString(),
      }));
    localStorage.setItem(REJECTED_KEY, JSON.stringify([...rejected(), ...parked]));
  }

  const settled = new Set([...result.accepted, ...result.duplicates, ...refused.keys()]);
  write(orders.filter((o) => !settled.has(o.idempotencyKey)));
  return result;
}

export function startAutoDrain(registerId: string, onChange?: (pending: number) => void) {
  const tick = async () => {
    if (navigator.onLine) {
      try {
        await drain(registerId);
      } catch {
        /* stay queued */
      }
    }
    onChange?.(pendingCount());
  };
  const id = setInterval(tick, 10_000);
  window.addEventListener('online', tick);
  return () => {
    clearInterval(id);
    window.removeEventListener('online', tick);
  };
}
