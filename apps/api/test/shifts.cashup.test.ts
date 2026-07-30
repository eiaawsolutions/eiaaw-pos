import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from './setup';
import {
  assertLedgerBalanced,
  line,
  makeOutlet,
  makeProduct,
  makeRegister,
  makeUser,
  orderDto,
} from './fixtures';
import { OrdersService } from '../src/orders/orders.service';
import { ShiftsService } from '../src/shifts/shifts.service';

/**
 * Cash-up answers one question: does the money in this drawer match what this
 * till took? Every term in that sum has to be scoped to the one shift. Filtering
 * the ledger by timestamp alone — which is what this replaces — sweeps in every
 * other register, in every other outlet, that was trading in the same window,
 * and hands the cashier an over/short in the thousands on a normal day.
 */
describe('shifts — blind cash-up', () => {
  let shifts: ShiftsService;
  let orders: OrdersService;

  beforeEach(() => {
    shifts = new ShiftsService(prisma as never);
    orders = new OrdersService(prisma as never);
  });

  async function till(opts: { outletId?: string; float?: number } = {}) {
    const outletId = opts.outletId ?? (await makeOutlet()).id;
    const register = await makeRegister(outletId);
    const user = await makeUser();
    const { variant } = await makeProduct({ outletId, price: 1000, taxCode: 'ZRL', onHand: 1000 });
    const shift = await shifts.open({
      outletId,
      registerId: register.id,
      userId: user.id,
      openingFloat: opts.float ?? 10_000,
    });
    return { outletId, registerId: register.id, userId: user.id, variant, shift };
  }

  async function sell(
    t: Awaited<ReturnType<typeof till>>,
    opts: { tender?: 'CASH' | 'CARD_MANUAL' | 'DUITNOW_QR'; tendered?: number; qty?: number } = {},
  ) {
    const qty = opts.qty ?? 1;
    const tender = opts.tender ?? 'CASH';
    return orders.create(
      orderDto({
        outletId: t.outletId,
        registerId: t.registerId,
        staffId: t.userId,
        lines: [line(t.variant, { unitPrice: 1000, qty })],
        payments: [{ tender, amount: opts.tendered ?? 1000 * qty }],
      }),
    );
  }

  describe('scoping', () => {
    it('counts only the sales taken on this register', async () => {
      const mine = await till({ float: 10_000 });
      const theirs = await till({ outletId: mine.outletId, float: 10_000 });

      await sell(mine, { qty: 2 }); // RM20 into my drawer
      await sell(theirs, { qty: 9 }); // RM90 into the next drawer along

      const closed = await shifts.close(mine.shift.id, 30_000, mine.userId);

      expect(closed.expectedCash).toBe(10_000 + 2000);
      expect(closed.overShort).toBe(30_000 - 12_000);
    });

    it('ignores a shift running at another outlet entirely', async () => {
      const kl = await till({ float: 5000 });
      const penang = await till({ float: 5000 });

      await sell(kl);
      await sell(penang, { qty: 7 });

      const closed = await shifts.close(kl.shift.id, 6000, kl.userId);
      expect(closed.expectedCash).toBe(6000);
      expect(closed.overShort).toBe(0);
    });

    it('does not sweep in takings from a shift that already closed on the same register', async () => {
      const outletId = (await makeOutlet()).id;
      const register = await makeRegister(outletId);
      const user = await makeUser();
      const { variant } = await makeProduct({ outletId, price: 1000, taxCode: 'ZRL', onHand: 1000 });

      const morning = await shifts.open({
        outletId,
        registerId: register.id,
        userId: user.id,
        openingFloat: 10_000,
      });
      const sale = () =>
        orders.create(
          orderDto({
            outletId,
            registerId: register.id,
            staffId: user.id,
            lines: [line(variant, { unitPrice: 1000 })],
            payments: [{ tender: 'CASH', amount: 1000 }],
          }),
        );
      await sale();
      await shifts.close(morning.id, 11_000, user.id);

      const evening = await shifts.open({
        outletId,
        registerId: register.id,
        userId: user.id,
        openingFloat: 10_000,
      });
      await sale();
      const closed = await shifts.close(evening.id, 11_000, user.id);

      expect(closed.expectedCash).toBe(11_000);
      expect(closed.overShort).toBe(0);
    });

    it('stamps the shift onto the order so X/Z reports can be cut per till', async () => {
      const t = await till();
      const { order } = await sell(t);
      const saved = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(saved.shiftId).toBe(t.shift.id);
    });

    it('flags cash taken while no shift was open — it can never be cashed up', async () => {
      const outletId = (await makeOutlet()).id;
      const register = await makeRegister(outletId);
      const user = await makeUser();
      const { variant } = await makeProduct({ outletId, price: 1000, taxCode: 'ZRL' });

      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId: register.id,
          staffId: user.id,
          lines: [line(variant, { unitPrice: 1000 })],
          payments: [{ tender: 'CASH', amount: 1000 }],
        }),
      );

      expect(
        await prisma.auditLog.count({ where: { action: 'CASH_OUTSIDE_SHIFT', entityId: order.id } }),
      ).toBe(1);
    });
  });

  describe('what belongs in the drawer', () => {
    it('starts from the opening float', async () => {
      const t = await till({ float: 15_000 });
      const closed = await shifts.close(t.shift.id, 15_000, t.userId);
      expect(closed.expectedCash).toBe(15_000);
    });

    it('leaves electronic tenders out of it', async () => {
      const t = await till({ float: 10_000 });
      await sell(t, { tender: 'CARD_MANUAL' });
      await sell(t, { tender: 'DUITNOW_QR' });

      const closed = await shifts.close(t.shift.id, 10_000, t.userId);
      expect(closed.expectedCash).toBe(10_000);
    });

    it('deducts the change handed back', async () => {
      const t = await till({ float: 10_000 });
      await sell(t, { tendered: 5000 }); // RM10 sale, RM50 note, RM40 change

      const closed = await shifts.close(t.shift.id, 11_000, t.userId);
      expect(closed.expectedCash).toBe(11_000);
      await assertLedgerBalanced();
    });

    it('adds a cash-in and subtracts a cash-out', async () => {
      const t = await till({ float: 10_000 });
      await shifts.cashMovement({ shiftId: t.shift.id, userId: t.userId, type: 'CASH_IN', amount: 3000 });
      await shifts.cashMovement({ shiftId: t.shift.id, userId: t.userId, type: 'CASH_OUT', amount: 1000 });

      const closed = await shifts.close(t.shift.id, 12_000, t.userId);
      expect(closed.expectedCash).toBe(12_000);
      expect(closed.overShort).toBe(0);
    });

    it('treats a drop to the safe as money leaving the drawer', async () => {
      // The bug this replaces summed unsigned amounts, so banking RM500 made
      // the till look RM500 *richer* and the cashier RM1000 short.
      const t = await till({ float: 10_000 });
      await sell(t, { qty: 50 }); // RM500 taken
      await shifts.cashMovement({ shiftId: t.shift.id, userId: t.userId, type: 'DROP', amount: 50_000 });

      const closed = await shifts.close(t.shift.id, 10_000, t.userId);
      expect(closed.expectedCash).toBe(10_000);
      expect(closed.overShort).toBe(0);
    });

    it('stores movements already signed, and refuses a negative magnitude', async () => {
      const t = await till();
      const drop = await shifts.cashMovement({
        shiftId: t.shift.id,
        userId: t.userId,
        type: 'DROP',
        amount: 5000,
      });
      expect(drop.amount).toBe(-5000);

      await expect(
        shifts.cashMovement({ shiftId: t.shift.id, userId: t.userId, type: 'DROP', amount: -5000 }),
      ).rejects.toThrow(/positive/i);

      await expect(
        shifts.cashMovement({ shiftId: t.shift.id, userId: t.userId, type: 'SKIM', amount: 100 }),
      ).rejects.toThrow(/unknown cash movement type/i);
    });

    it('refuses a cash movement against a shift that is already closed', async () => {
      const t = await till();
      await shifts.close(t.shift.id, 10_000, t.userId);

      await expect(
        shifts.cashMovement({ shiftId: t.shift.id, userId: t.userId, type: 'CASH_IN', amount: 100 }),
      ).rejects.toThrow(/closed/i);
    });

    it('takes a voided cash sale back out of the drawer that refunds it', async () => {
      const t = await till({ float: 10_000 });
      const { order } = await sell(t, { qty: 3 }); // RM30 in

      await orders.void(order.id, t.userId, 'customer changed their mind');

      const closed = await shifts.close(t.shift.id, 10_000, t.userId);
      expect(closed.expectedCash).toBe(10_000);
      expect(closed.overShort).toBe(0);
      await assertLedgerBalanced();
    });

    it('balances the ledger when voiding a sale that was overpaid in cash', async () => {
      // Change given means the till only ever kept the total; reversing the
      // full amount tendered would credit money that was handed straight back.
      const t = await till({ float: 10_000 });
      const { order } = await sell(t, { tendered: 5000 });

      await orders.void(order.id, t.userId, 'wrong item');

      await assertLedgerBalanced();
      const closed = await shifts.close(t.shift.id, 10_000, t.userId);
      expect(closed.expectedCash).toBe(10_000);
    });
  });

  describe('opening and closing', () => {
    it('refuses a second shift on a register that already has one open', async () => {
      const t = await till();
      await expect(
        shifts.open({ outletId: t.outletId, registerId: t.registerId, userId: t.userId, openingFloat: 0 }),
      ).rejects.toThrow(/already open/i);
    });

    it('holds that line even when two cashiers open the till at the same instant', async () => {
      // Two opens racing past a check-then-insert both succeed, and from then
      // on the register has two "current" shifts and cash lands in whichever
      // one the query happens to return.
      const outletId = (await makeOutlet()).id;
      const register = await makeRegister(outletId);
      const user = await makeUser();

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          shifts.open({ outletId, registerId: register.id, userId: user.id, openingFloat: 10_000 }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.shift.count({ where: { registerId: register.id, closedAt: null } })).toBe(1);
    });

    it('frees the register for the next shift once closed', async () => {
      const t = await till();
      await shifts.close(t.shift.id, 10_000, t.userId);

      const next = await shifts.open({
        outletId: t.outletId,
        registerId: t.registerId,
        userId: t.userId,
        openingFloat: 10_000,
      });
      expect(next.id).not.toBe(t.shift.id);
    });

    it('refuses to close a shift twice', async () => {
      const t = await till();
      await shifts.close(t.shift.id, 10_000, t.userId);
      await expect(shifts.close(t.shift.id, 10_000, t.userId)).rejects.toThrow(/already closed/i);
    });

    it('closes exactly once when the close button is double-tapped', async () => {
      const t = await till({ float: 10_000 });
      await sell(t);

      const results = await Promise.allSettled([
        shifts.close(t.shift.id, 11_000, t.userId),
        shifts.close(t.shift.id, 11_000, t.userId),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.auditLog.count({ where: { action: 'SHIFT_CLOSE', entityId: t.shift.id } })).toBe(1);
    });

    it('records the count, the expectation and the variance', async () => {
      const t = await till({ float: 10_000 });
      await sell(t, { qty: 3 });

      const closed = await shifts.close(t.shift.id, 12_950, t.userId);
      expect(closed.closingCount).toBe(12_950);
      expect(closed.expectedCash).toBe(13_000);
      expect(closed.overShort).toBe(-50); // 50 sen short
      expect(closed.closedAt).not.toBeNull();
    });

    it('leaves the over/short on the audit trail', async () => {
      const t = await till({ float: 10_000 });
      await shifts.close(t.shift.id, 9_500, t.userId);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'SHIFT_CLOSE', entityId: t.shift.id },
      });
      expect(audit.detail).toMatchObject({ overShort: -500 });
    });

    it('reports the open shift for a register', async () => {
      const t = await till();
      const current = await shifts.current(t.registerId);
      expect(current?.id).toBe(t.shift.id);

      await shifts.close(t.shift.id, 10_000, t.userId);
      expect(await shifts.current(t.registerId)).toBeNull();
    });
  });
});
