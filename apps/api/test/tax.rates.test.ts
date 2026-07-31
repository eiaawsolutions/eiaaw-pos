import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from './setup';
import {
  line,
  makeOutlet,
  makeProduct,
  makeRegister,
  makeUser,
  orderDto,
  ordersService,
  seedDiscountPolicies,
  seedTaxCodes,
} from './fixtures';
import type { OrdersService } from '../src/orders/orders.service';
import { TaxService } from '../src/catalog/tax.service';

/**
 * Rates are data, not code. They change on gazetted dates — Malaysian service
 * tax went 6% to 8% on 1 March 2024 — and the rate that applied to a sale is a
 * property of when the sale happened, not of which build was deployed. A
 * compiled-in table cannot express "both, and here is the boundary".
 */
describe('tax rates — effective-dated and configurable', () => {
  let tax: TaxService;

  beforeEach(async () => {
    tax = new TaxService(prisma as never);
    await seedTaxCodes();
  });

  describe('resolving a rate', () => {
    it('reads the seeded statutory rates', async () => {
      expect(await tax.rateFor('SST8', new Date())).toBe(800);
      expect(await tax.rateFor('SST6', new Date())).toBe(600);
      expect(await tax.rateFor('ZRL', new Date())).toBe(0);
      expect(await tax.rateFor('EXEMPT', new Date())).toBe(0);
    });

    it('returns the rate in force at the moment asked, not the newest', async () => {
      await prisma.taxCode.create({ data: { code: 'SVC', name: 'Service Tax' } });
      await prisma.taxRate.createMany({
        data: [
          { code: 'SVC', rateBps: 600, effectiveFrom: new Date('2018-09-01T00:00:00Z') },
          { code: 'SVC', rateBps: 800, effectiveFrom: new Date('2024-03-01T00:00:00Z') },
        ],
      });

      expect(await tax.rateFor('SVC', new Date('2020-01-01T00:00:00Z'))).toBe(600);
      expect(await tax.rateFor('SVC', new Date('2024-02-29T23:59:59Z'))).toBe(600);
      expect(await tax.rateFor('SVC', new Date('2024-03-01T00:00:00Z'))).toBe(800);
      expect(await tax.rateFor('SVC', new Date('2026-01-01T00:00:00Z'))).toBe(800);
    });

    it('ignores a rate scheduled for the future', async () => {
      await prisma.taxCode.create({ data: { code: 'FUT', name: 'Announced but not in force' } });
      await prisma.taxRate.createMany({
        data: [
          { code: 'FUT', rateBps: 500, effectiveFrom: new Date('2020-01-01T00:00:00Z') },
          { code: 'FUT', rateBps: 900, effectiveFrom: new Date('2099-01-01T00:00:00Z') },
        ],
      });

      expect(await tax.rateFor('FUT', new Date())).toBe(500);
    });

    it('refuses a code with no rate yet in force rather than assuming zero', async () => {
      // Assuming zero under-declares SST on every sale of that item and leaves
      // nothing behind to find it by.
      await prisma.taxCode.create({ data: { code: 'PENDING', name: 'Awaiting its first rate' } });

      await expect(tax.rateFor('PENDING', new Date())).rejects.toThrow(/no rate/i);
    });

    it('refuses a code that does not exist', async () => {
      await expect(tax.rateFor('NOPE', new Date())).rejects.toThrow(/no rate|unknown/i);
    });
  });

  describe('scheduling a change', () => {
    it('adds a future rate without disturbing the one in force', async () => {
      await tax.scheduleRate({
        code: 'SST8',
        rateBps: 1000,
        effectiveFrom: new Date('2099-01-01T00:00:00Z'),
        note: 'Budget 2099',
        userId: null,
      });

      expect(await tax.rateFor('SST8', new Date())).toBe(800);
      expect(await tax.rateFor('SST8', new Date('2099-06-01T00:00:00Z'))).toBe(1000);
    });

    it('refuses to restate history by reusing an effective date', async () => {
      const when = new Date('2030-01-01T00:00:00Z');
      await tax.scheduleRate({ code: 'SST8', rateBps: 900, effectiveFrom: when, userId: null });

      await expect(
        tax.scheduleRate({ code: 'SST8', rateBps: 950, effectiveFrom: when, userId: null }),
      ).rejects.toThrow(/already/i);
    });

    it('refuses a nonsense rate', async () => {
      for (const rateBps of [-1, 1.5, 200_000]) {
        await expect(
          tax.scheduleRate({ code: 'SST8', rateBps, effectiveFrom: new Date('2031-01-01Z'), userId: null }),
        ).rejects.toThrow(/rate/i);
      }
    });

    it('refuses a code the catalog does not know', async () => {
      await expect(
        tax.scheduleRate({
          code: 'INVENTED',
          rateBps: 500,
          effectiveFrom: new Date('2031-01-01Z'),
          userId: null,
        }),
      ).rejects.toThrow(/unknown tax code/i);
    });
  });

  describe('what the terminal is told', () => {
    it('lists the codes with the rate currently in force', async () => {
      const codes = await tax.effectiveRates(new Date());
      expect(codes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'SST8', rateBps: 800 }),
          expect.objectContaining({ code: 'ZRL', rateBps: 0 }),
        ]),
      );
    });

    it('leaves out inactive codes and any with no rate in force', async () => {
      await prisma.taxCode.create({ data: { code: 'OLD', name: 'Retired', active: false } });
      await prisma.taxRate.create({
        data: { code: 'OLD', rateBps: 400, effectiveFrom: new Date('2000-01-01Z') },
      });
      await prisma.taxCode.create({ data: { code: 'BLANK', name: 'No rate yet' } });

      const codes = await tax.effectiveRates(new Date());
      expect(codes.map((c) => c.code)).not.toContain('OLD');
      expect(codes.map((c) => c.code)).not.toContain('BLANK');
    });
  });

  describe('pricing a sale through it', () => {
    let orders: OrdersService;
    let outletId: string;
    let registerId: string;
    let staffId: string;

    beforeEach(async () => {
      await seedDiscountPolicies();
      orders = ordersService();
      outletId = (await makeOutlet()).id;
      registerId = (await makeRegister(outletId)).id;
      staffId = (await makeUser({ role: 'OWNER' })).id;
    });

    it('charges the configured rate', async () => {
      const { variant } = await makeProduct({ outletId, price: 1080, taxCode: 'SST8' });

      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 1080 })],
          payments: [{ tender: 'CARD_MANUAL', amount: 1080 }],
        }),
      );

      expect(order.taxTotal).toBe(80);
    });

    it('follows a rate change without a deploy', async () => {
      const { variant } = await makeProduct({ outletId, price: 10_600, taxCode: 'SST6' });

      const before = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 10_600 })],
          payments: [{ tender: 'CARD_MANUAL', amount: 10_600 }],
        }),
      );
      expect(before.order.taxTotal).toBe(600);

      // The rate rises, effective immediately.
      await tax.scheduleRate({
        code: 'SST6',
        rateBps: 800,
        effectiveFrom: new Date(Date.now() - 1000),
        userId: null,
      });

      const after = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 10_600 })],
          payments: [{ tender: 'CARD_MANUAL', amount: 10_600 }],
        }),
      );
      expect(after.order.taxTotal).toBe(785); // 10600 * 800 / 10800
    });

    it('leaves the tax already charged on past orders alone', async () => {
      const { variant } = await makeProduct({ outletId, price: 10_600, taxCode: 'SST6' });
      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 10_600 })],
          payments: [{ tender: 'CARD_MANUAL', amount: 10_600 }],
        }),
      );

      await tax.scheduleRate({
        code: 'SST6',
        rateBps: 800,
        effectiveFrom: new Date(Date.now() - 1000),
        userId: null,
      });

      const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(reread.taxTotal).toBe(600); // what the merchant filed against
    });

    it('refuses the sale when the item carries a code with no rate in force', async () => {
      await prisma.taxCode.create({ data: { code: 'UNSET', name: 'No rate' } });
      const { variant } = await makeProduct({ outletId, price: 1000, taxCode: 'UNSET' });

      await expect(
        orders.create(
          orderDto({
            outletId,
            registerId,
            staffId,
            lines: [line(variant, { unitPrice: 1000 })],
            payments: [{ tender: 'CASH', amount: 1000 }],
          }),
        ),
      ).rejects.toThrow(/rate/i);
    });
  });
});
