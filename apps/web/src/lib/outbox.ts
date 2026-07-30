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

function read(): CreateOrderDto[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
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

export async function drain(registerId: string): Promise<SyncResult | null> {
  const orders = read();
  if (!orders.length) return null;
  const result = await api<SyncResult>('/sync/orders', {
    method: 'POST',
    body: JSON.stringify({ registerId, orders }),
  });
  const settled = new Set([...result.accepted, ...result.duplicates]);
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
