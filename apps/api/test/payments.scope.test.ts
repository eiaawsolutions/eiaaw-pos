import { describe, it, expect, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { prisma } from './setup';
import {
  line,
  makeOutlet,
  makeProduct,
  makeRegister,
  makeUser,
  orderDto,
  ordersService,
  seedPolicyDefaults,
} from './fixtures';
import { PaymentsService } from '../src/payments/payments.service';
import { resolveOutletScope } from '../src/common/auth.guard';

/**
 * Reconciliation is the day's takings, by tender. It was the one outlet-scoped
 * read that took a date and nothing else, while inventory, orders, reports and
 * shifts all resolved the outlet through the caller — so a manager pinned to
 * one shop could read the whole business.
 */
describe('payments — reconciliation is scoped to the caller', () => {
  let payments: PaymentsService;
  let outletA: string;
  let outletB: string;

  beforeEach(async () => {
    await seedPolicyDefaults();
    payments = new PaymentsService(prisma as never);
    outletA = (await makeOutlet()).id;
    outletB = (await makeOutlet()).id;

    const orders = ordersService();
    for (const [outletId, price] of [
      [outletA, 1000],
      [outletB, 7000],
    ] as const) {
      const register = await makeRegister(outletId);
      const staff = await makeUser({ role: 'OWNER' });
      const { variant } = await makeProduct({ outletId, price, taxCode: 'ZRL' });
      await orders.create(
        orderDto({
          outletId,
          registerId: register.id,
          staffId: staff.id,
          lines: [line(variant, { unitPrice: price })],
          payments: [{ tender: 'CASH', amount: price }],
        }),
      );
    }
  });

  const today = () => new Date().toISOString().slice(0, 10);
  const cashNet = (rows: { account: string; net: number }[]) =>
    rows.find((r) => r.account === 'TENDER_CASH')?.net ?? 0;

  it('reports only the outlet asked for', async () => {
    expect(cashNet(await payments.reconciliation(today(), outletA))).toBe(1000);
    expect(cashNet(await payments.reconciliation(today(), outletB))).toBe(7000);
  });

  it('reports the whole business when no outlet is given', async () => {
    // Which is what an unpinned owner gets, and only them.
    expect(cashNet(await payments.reconciliation(today()))).toBe(8000);
  });

  it('gives a pinned manager their own outlet and refuses another', () => {
    const pinned = { sub: 'u1', role: 'MANAGER', outletId: outletA };
    expect(resolveOutletScope(pinned, undefined)).toBe(outletA);
    expect(resolveOutletScope(pinned, outletA)).toBe(outletA);
    expect(() => resolveOutletScope(pinned, outletB)).toThrow(ForbiddenException);
  });

  it('does not let one outlet see another through the day total', async () => {
    // The whole point: the number a pinned manager reads must not include
    // takings from a shop they have no business seeing.
    const pinned = { sub: 'u1', role: 'MANAGER', outletId: outletA };
    const scoped = await payments.reconciliation(today(), resolveOutletScope(pinned, undefined));
    expect(cashNet(scoped)).toBe(1000);
    expect(cashNet(scoped)).not.toBe(8000);
  });
});
