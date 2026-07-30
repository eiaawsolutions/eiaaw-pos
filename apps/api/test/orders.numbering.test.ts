import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from './setup';
import { line, makeOutlet, makeProduct, makeRegister, makeUser, orderDto } from './fixtures';
import { OrdersService } from '../src/orders/orders.service';
import { businessDate } from '@eiaaw/shared';

/**
 * Receipt numbers are the thread an auditor pulls. They have to be unique,
 * unbroken, and stamped with the day the outlet was actually trading — none of
 * which a `COUNT(*) + 1` can promise once two terminals are selling at once.
 */
describe('orders — receipt numbering', () => {
  let orders: OrdersService;

  beforeEach(() => {
    orders = new OrdersService(prisma as never);
  });

  async function outletWithStock(timezone?: string) {
    const outlet = await makeOutlet(timezone ? { timezone } : {});
    const register = await makeRegister(outlet.id);
    const staff = await makeUser();
    const { variant } = await makeProduct({ outletId: outlet.id, price: 500, onHand: 10_000 });
    return { outlet, registerId: register.id, staffId: staff.id, variant };
  }

  it('gives every concurrent sale its own number', async () => {
    // The failure this replaces: both terminals read the same COUNT, both build
    // "…-00001-…", the unique index rejects the loser, and a customer is stood
    // at the counter watching a sale fail during the busiest minute of the day.
    const { outlet, registerId, staffId, variant } = await outletWithStock();
    const CONCURRENT = 24;

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT }, () =>
        orders.create(
          orderDto({
            outletId: outlet.id,
            registerId,
            staffId,
            lines: [line(variant, { unitPrice: 500 })],
            payments: [{ tender: 'CASH', amount: 500 }],
          }),
        ),
      ),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => (r as PromiseRejectedResult).reason?.message)).toEqual([]);

    const saved = await prisma.order.findMany({ select: { orderNo: true } });
    expect(saved).toHaveLength(CONCURRENT);
    expect(new Set(saved.map((o) => o.orderNo)).size).toBe(CONCURRENT);
  });

  it('numbers them 1..N with no gaps and no repeats', async () => {
    const { outlet, registerId, staffId, variant } = await outletWithStock();
    const CONCURRENT = 24;

    await Promise.all(
      Array.from({ length: CONCURRENT }, () =>
        orders.create(
          orderDto({
            outletId: outlet.id,
            registerId,
            staffId,
            lines: [line(variant, { unitPrice: 500 })],
            payments: [{ tender: 'CASH', amount: 500 }],
          }),
        ),
      ),
    );

    const saved = await prisma.order.findMany({ select: { orderNo: true } });
    const sequences = saved.map((o) => Number(o.orderNo.split('-')[1])).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: CONCURRENT }, (_, i) => i + 1));
  });

  it('dates the number by the outlet timezone, not the server timezone', async () => {
    // Two outlets 25 hours apart are never on the same calendar date, whatever
    // the host clock is doing, so this holds at any instant the suite runs.
    const east = await outletWithStock('Pacific/Kiritimati'); // UTC+14
    const west = await outletWithStock('Pacific/Midway'); // UTC-11

    for (const o of [east, west]) {
      await orders.create(
        orderDto({
          outletId: o.outlet.id,
          registerId: o.registerId,
          staffId: o.staffId,
          lines: [line(o.variant, { unitPrice: 500 })],
          payments: [{ tender: 'CASH', amount: 500 }],
        }),
      );
    }

    const [eastOrder, westOrder] = await Promise.all([
      prisma.order.findFirstOrThrow({ where: { outletId: east.outlet.id } }),
      prisma.order.findFirstOrThrow({ where: { outletId: west.outlet.id } }),
    ]);

    const prefix = (orderNo: string) => orderNo.split('-')[0];
    const expected = (tz: string) => businessDate(new Date(), tz).replace(/-/g, '');

    expect(prefix(eastOrder.orderNo)).toBe(expected('Pacific/Kiritimati'));
    expect(prefix(westOrder.orderNo)).toBe(expected('Pacific/Midway'));
    expect(prefix(eastOrder.orderNo)).not.toBe(prefix(westOrder.orderNo));
  });

  it('keeps a separate sequence per outlet', async () => {
    const a = await outletWithStock();
    const b = await outletWithStock();

    for (const o of [a, b, a]) {
      await orders.create(
        orderDto({
          outletId: o.outlet.id,
          registerId: o.registerId,
          staffId: o.staffId,
          lines: [line(o.variant, { unitPrice: 500 })],
          payments: [{ tender: 'CASH', amount: 500 }],
        }),
      );
    }

    const bOrders = await prisma.order.findMany({ where: { outletId: b.outlet.id } });
    expect(bOrders[0].orderNo.split('-')[1]).toBe('00001');

    const aOrders = await prisma.order.findMany({
      where: { outletId: a.outlet.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(aOrders.map((o) => o.orderNo.split('-')[1])).toEqual(['00001', '00002']);
  });

  it('does not burn a number on a sale that was refused', async () => {
    // A rejected request must not leave a hole in the receipt run — a gap is a
    // question the merchant gets asked and cannot answer.
    const { outlet, registerId, staffId, variant } = await outletWithStock();

    await expect(
      orders.create(
        orderDto({
          outletId: outlet.id,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 500 })],
          payments: [{ tender: 'CASH', amount: 1 }],
        }),
      ),
    ).rejects.toThrow();

    const { order } = await orders.create(
      orderDto({
        outletId: outlet.id,
        registerId,
        staffId,
        lines: [line(variant, { unitPrice: 500 })],
        payments: [{ tender: 'CASH', amount: 500 }],
      }),
    );

    expect(order.orderNo.split('-')[1]).toBe('00001');
  });

  it('does not consume a number for an idempotent replay', async () => {
    const { outlet, registerId, staffId, variant } = await outletWithStock();
    const dto = orderDto({
      outletId: outlet.id,
      registerId,
      staffId,
      lines: [line(variant, { unitPrice: 500 })],
      payments: [{ tender: 'CASH', amount: 500 }],
    });

    const first = await orders.create(dto);
    const replay = await orders.create(dto);

    expect(replay.duplicate).toBe(true);
    expect(replay.order.orderNo).toBe(first.order.orderNo);

    const sequence = await prisma.orderSequence.findFirstOrThrow({ where: { outletId: outlet.id } });
    expect(sequence.lastValue).toBe(1);
  });

  it('picks up after receipt numbers that predate the sequence table', async () => {
    // Every deployment that has already traded carries orders numbered by the
    // old count-based scheme, and nothing wrote those into the sequence. Left
    // alone, the first sale after the upgrade allocates 1, collides with the
    // number already on a receipt, and returns a 500 to the counter.
    const { outlet, registerId, staffId, variant } = await outletWithStock();
    const today = businessDate(new Date(), outlet.timezone).replace(/-/g, '');

    await prisma.order.create({
      data: {
        orderNo: `${today}-00007-${outlet.id.slice(-4)}`,
        idempotencyKey: 'legacy-order',
        outletId: outlet.id,
        subtotal: 500,
        total: 500,
      },
    });

    const { order } = await orders.create(
      orderDto({
        outletId: outlet.id,
        registerId,
        staffId,
        lines: [line(variant, { unitPrice: 500 })],
        payments: [{ tender: 'CASH', amount: 500 }],
      }),
    );

    expect(order.orderNo).toBe(`${today}-00008-${outlet.id.slice(-4)}`);
  });

  it('ignores yesterday and other outlets when picking up that sequence', async () => {
    const { outlet, registerId, staffId, variant } = await outletWithStock();
    const other = await outletWithStock();
    const today = businessDate(new Date(), outlet.timezone).replace(/-/g, '');

    await prisma.order.createMany({
      data: [
        {
          orderNo: `19990101-00099-${outlet.id.slice(-4)}`,
          idempotencyKey: 'legacy-yesterday',
          outletId: outlet.id,
          subtotal: 500,
          total: 500,
        },
        {
          orderNo: `${today}-00042-${other.outlet.id.slice(-4)}`,
          idempotencyKey: 'legacy-other-outlet',
          outletId: other.outlet.id,
          subtotal: 500,
          total: 500,
        },
      ],
    });

    const { order } = await orders.create(
      orderDto({
        outletId: outlet.id,
        registerId,
        staffId,
        lines: [line(variant, { unitPrice: 500 })],
        payments: [{ tender: 'CASH', amount: 500 }],
      }),
    );

    expect(order.orderNo).toBe(`${today}-00001-${outlet.id.slice(-4)}`);
  });

  it('is not confused by a locally-numbered offline receipt', async () => {
    // The terminal prints `LOCAL-xxxxxxxx` when it sells with no network, and
    // that string has no sequence in it to parse.
    const { outlet, registerId, staffId, variant } = await outletWithStock();

    await prisma.order.create({
      data: {
        orderNo: 'LOCAL-a1b2c3d4',
        idempotencyKey: 'legacy-local',
        outletId: outlet.id,
        subtotal: 500,
        total: 500,
      },
    });

    const { order } = await orders.create(
      orderDto({
        outletId: outlet.id,
        registerId,
        staffId,
        lines: [line(variant, { unitPrice: 500 })],
        payments: [{ tender: 'CASH', amount: 500 }],
      }),
    );

    expect(order.orderNo.split('-')[1]).toBe('00001');
  });

  it('carries the outlet in the number so receipts stay distinguishable', async () => {
    const { outlet, registerId, staffId, variant } = await outletWithStock();

    const { order } = await orders.create(
      orderDto({
        outletId: outlet.id,
        registerId,
        staffId,
        lines: [line(variant, { unitPrice: 500 })],
        payments: [{ tender: 'CASH', amount: 500 }],
      }),
    );

    expect(order.orderNo).toMatch(/^\d{8}-\d{5}-\w{4}$/);
    expect(order.orderNo.endsWith(outlet.id.slice(-4))).toBe(true);
  });
});
