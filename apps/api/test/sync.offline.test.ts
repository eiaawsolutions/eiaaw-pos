import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from './setup';
import { line, makeOutlet, makeProduct, makeRegister, makeUser, orderDto } from './fixtures';
import { OrdersService } from '../src/orders/orders.service';
import { SyncController } from '../src/sync/sync.controller';

/**
 * Orders taken offline are priced against whatever catalog the terminal had
 * cached, then re-priced here on arrival. That makes rejection a normal
 * outcome rather than an exceptional one, so the batch result has to tell the
 * terminal which failures are worth retrying and which will fail forever.
 */
describe('sync — draining the offline outbox', () => {
  let sync: SyncController;
  let orders: OrdersService;
  let outletId: string;
  let registerId: string;
  let staffId: string;

  beforeEach(async () => {
    orders = new OrdersService(prisma as never);
    sync = new SyncController(orders);
    outletId = (await makeOutlet()).id;
    registerId = (await makeRegister(outletId)).id;
    staffId = (await makeUser()).id;
  });

  it('accepts a batch and acknowledges a replay without re-posting it', async () => {
    const { variant } = await makeProduct({ outletId, price: 500, taxCode: 'ZRL' });
    const dto = orderDto({
      outletId,
      registerId,
      staffId,
      lines: [line(variant, { unitPrice: 500 })],
      payments: [{ tender: 'CASH', amount: 500 }],
    });

    const first = await sync.syncOrders({ registerId, orders: [dto] });
    expect(first.accepted).toEqual([dto.idempotencyKey]);

    const replay = await sync.syncOrders({ registerId, orders: [dto] });
    expect(replay.duplicates).toEqual([dto.idempotencyKey]);
    expect(await prisma.order.count()).toBe(1);
  });

  it('marks a sale priced off a stale catalog as permanently refused', async () => {
    // The terminal sold at yesterday's RM4.50 and took RM4.50. The shelf price
    // is RM5.00 now, so re-pricing leaves the order underpaid — and it will be
    // underpaid on every retry from here to the end of time.
    const { variant } = await makeProduct({ outletId, price: 500, taxCode: 'ZRL' });
    const dto = orderDto({
      outletId,
      registerId,
      staffId,
      lines: [line(variant, { unitPrice: 450 })],
      payments: [{ tender: 'CASH', amount: 450 }],
      offline: true,
    });

    const result = await sync.syncOrders({ registerId, orders: [dto] });

    expect(result.accepted).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ key: dto.idempotencyKey, permanent: true });
    expect(result.failed[0].reason).toMatch(/underpaid/i);
  });

  it('leaves a server-side fault retryable', async () => {
    // Anything that is not the server judging the request itself may well
    // succeed on the next attempt, so the terminal must keep it queued.
    const failing = {
      create: async () => {
        throw new Error('connection terminated unexpectedly');
      },
    } as unknown as OrdersService;

    const result = await new SyncController(failing).syncOrders({
      registerId,
      orders: [orderDto({ outletId, registerId, lines: [] })],
    });

    expect(result.failed[0].permanent).toBe(false);
  });

  it('settles the good orders in a batch even when one of them is refused', async () => {
    const { variant } = await makeProduct({ outletId, price: 500, taxCode: 'ZRL' });
    const good = orderDto({
      outletId,
      registerId,
      staffId,
      lines: [line(variant, { unitPrice: 500 })],
      payments: [{ tender: 'CASH', amount: 500 }],
    });
    const bad = orderDto({
      outletId,
      registerId,
      staffId,
      lines: [line({ id: 'gone', sku: 'GONE', name: 'Delisted' }, { unitPrice: 500 })],
      payments: [{ tender: 'CASH', amount: 500 }],
    });

    const result = await sync.syncOrders({ registerId, orders: [bad, good] });

    expect(result.accepted).toEqual([good.idempotencyKey]);
    expect(result.failed.map((f) => f.key)).toEqual([bad.idempotencyKey]);
    expect(result.failed[0].permanent).toBe(true);
  });
});
