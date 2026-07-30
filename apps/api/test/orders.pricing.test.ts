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
import { TAX } from '@eiaaw/shared';

/**
 * The terminal is not a trusted input. It runs on hardware the merchant's staff
 * hold, over a network anyone in the venue shares, and its request body is a
 * few keystrokes away in any browser devtools. Everything that decides how much
 * money changes hands — unit price, tax, rounding — has to be recomputed here,
 * from the catalog, and the request's own numbers treated as a claim to check
 * rather than a figure to record.
 */
describe('orders — the server is the pricing authority', () => {
  let orders: OrdersService;
  let outletId: string;
  let registerId: string;
  let staffId: string;

  beforeEach(async () => {
    orders = new OrdersService(prisma as never);
    const outlet = await makeOutlet();
    outletId = outlet.id;
    registerId = (await makeRegister(outletId)).id;
    staffId = (await makeUser()).id;
  });

  describe('unit price', () => {
    it('records the catalog price, not the price the terminal claimed', async () => {
      const { variant } = await makeProduct({ outletId, price: 4900 }); // RM49 t-shirt

      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 1 })], // "1 sen, please"
          payments: [{ tender: 'CASH', amount: 4900 }],
        }),
      );

      const saved = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { lines: true },
      });
      expect(saved.lines[0].unitPrice).toBe(4900);
      expect(saved.lines[0].total).toBe(4900);
      expect(saved.subtotal).toBe(4900);
      expect(saved.total).toBe(4900);
    });

    it('rejects the whole attack when the tampered price is also underpaid', async () => {
      const { variant } = await makeProduct({ outletId, price: 4900 });

      // The realistic shape of the attack: claim a cent, tender a cent.
      await expect(
        orders.create(
          orderDto({
            outletId,
            registerId,
            staffId,
            lines: [line(variant, { unitPrice: 1 })],
            payments: [{ tender: 'CASH', amount: 1 }],
          }),
        ),
      ).rejects.toThrow(/underpaid/i);

      expect(await prisma.order.count()).toBe(0);
    });

    it('prices each line from its own variant when a cart mixes items', async () => {
      const a = await makeProduct({ outletId, price: 450, name: 'Teh Tarik' });
      const b = await makeProduct({ outletId, price: 850, name: 'Nasi Lemak' });

      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(a.variant, { unitPrice: 100, qty: 2 }), line(b.variant, { unitPrice: 100, qty: 1 })],
          payments: [{ tender: 'CARD_MANUAL', amount: 1750 }],
        }),
      );

      expect(order.subtotal).toBe(450 * 2 + 850);
      expect(order.total).toBe(1750);
    });

    it('refuses a variant that is not in the catalog', async () => {
      await expect(
        orders.create(
          orderDto({
            outletId,
            registerId,
            staffId,
            lines: [line({ id: 'no-such-variant', sku: 'X', name: 'Ghost' }, { unitPrice: 100 })],
            payments: [{ tender: 'CASH', amount: 100 }],
          }),
        ),
      ).rejects.toThrow(/unknown|not found/i);
    });

    it('refuses a variant that has been deactivated', async () => {
      const { variant } = await makeProduct({ outletId, price: 500, active: false });

      await expect(
        orders.create(
          orderDto({
            outletId,
            registerId,
            staffId,
            lines: [line(variant, { unitPrice: 500 })],
            payments: [{ tender: 'CASH', amount: 500 }],
          }),
        ),
      ).rejects.toThrow(/inactive|not available|unknown/i);
    });

    it('refuses a quantity that is not a positive whole number', async () => {
      const { variant } = await makeProduct({ outletId, price: 500 });

      for (const qty of [0, -3, 1.5]) {
        await expect(
          orders.create(
            orderDto({
              outletId,
              registerId,
              staffId,
              lines: [line(variant, { unitPrice: 500, qty })],
              payments: [{ tender: 'CASH', amount: 100_000 }],
            }),
          ),
        ).rejects.toThrow(/quantity/i);
      }
    });

    it('refuses an empty cart', async () => {
      await expect(orders.create(orderDto({ outletId, registerId, staffId, lines: [] }))).rejects.toThrow(
        /no lines/i,
      );
    });
  });

  describe('tax', () => {
    it('computes tax from the product tax code, ignoring what was sent', async () => {
      const { variant } = await makeProduct({ outletId, price: 1080, taxCode: 'SST8' });

      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 1080, taxCode: 'ZRL', taxAmount: 0 })],
          payments: [{ tender: 'CARD_MANUAL', amount: 1080 }],
        }),
      );

      expect(order.taxTotal).toBe(80); // 8% inside RM10.80
      const saved = await prisma.orderLine.findFirstOrThrow({ where: { orderId: order.id } });
      expect(saved.taxCode).toBe('SST8');
      expect(saved.taxAmount).toBe(80);
    });

    it('charges no tax on a zero-rated item even when the terminal claims some', async () => {
      const { variant } = await makeProduct({ outletId, price: 4900, taxCode: 'ZRL' });

      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 4900, taxCode: 'SST8', taxAmount: 363 })],
          payments: [{ tender: 'CARD_MANUAL', amount: 4900 }],
        }),
      );

      expect(order.taxTotal).toBe(0);
    });

    it('taxes the discounted amount, not the shelf price', async () => {
      // Tax follows the consideration actually paid.
      const { variant } = await makeProduct({ outletId, price: 1080, taxCode: 'SST8' });

      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 1080, discount: 540 })],
          payments: [{ tender: 'CARD_MANUAL', amount: 540 }],
        }),
      );

      expect(order.total).toBe(540);
      expect(order.taxTotal).toBe(TAX.inclusiveComponent(540, 'SST8')); // 40
    });

    it('fails the sale on a mis-configured tax code rather than quietly zero-rating it', async () => {
      const { variant } = await makeProduct({ outletId, price: 1000, taxCode: 'SST10' });

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
      ).rejects.toThrow(/tax code/i);
    });
  });

  describe('discounts', () => {
    it('refuses a discount larger than the line it sits on', async () => {
      // Otherwise the line goes negative and the "sale" pays the customer.
      const { variant } = await makeProduct({ outletId, price: 500 });

      await expect(
        orders.create(
          orderDto({
            outletId,
            registerId,
            staffId,
            lines: [line(variant, { unitPrice: 500, discount: 900 })],
            payments: [{ tender: 'CASH', amount: 0 }],
          }),
        ),
      ).rejects.toThrow(/discount/i);
    });

    it('refuses a negative discount — that is a price increase in disguise', async () => {
      const { variant } = await makeProduct({ outletId, price: 500 });

      await expect(
        orders.create(
          orderDto({
            outletId,
            registerId,
            staffId,
            lines: [line(variant, { unitPrice: 500, discount: -500 })],
            payments: [{ tender: 'CASH', amount: 1000 }],
          }),
        ),
      ).rejects.toThrow(/discount/i);
    });

    it('refuses a cart discount larger than the cart', async () => {
      const { variant } = await makeProduct({ outletId, price: 500 });

      await expect(
        orders.create(
          orderDto({
            outletId,
            registerId,
            staffId,
            lines: [line(variant, { unitPrice: 500 })],
            cartDiscount: 600,
            payments: [{ tender: 'CASH', amount: 0 }],
          }),
        ),
      ).rejects.toThrow(/discount/i);
    });

    it('leaves an audit trail whenever a discount is applied', async () => {
      const { variant } = await makeProduct({ outletId, price: 1000 });

      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 1000, discount: 200 })],
          payments: [{ tender: 'CARD_MANUAL', amount: 800 }],
        }),
      );

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'DISCOUNT', entityId: order.id },
      });
      expect(audit).not.toBeNull();
      expect(audit!.userId).toBe(staffId);
    });
  });

  describe('cash rounding', () => {
    it('recomputes the 5-sen adjustment instead of trusting the terminal', async () => {
      const { variant } = await makeProduct({ outletId, price: 453 });

      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 453 })],
          roundingAdjustment: -400, // "round RM4.53 down to RM0.53"
          payments: [{ tender: 'CASH', amount: 455 }],
        }),
      );

      expect(order.roundingAdjustment).toBe(2); // 453 -> 455
      expect(order.total).toBe(455);
    });

    it('does not round an electronic tender — those settle exact', async () => {
      const { variant } = await makeProduct({ outletId, price: 453 });

      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 453 })],
          roundingAdjustment: 2,
          payments: [{ tender: 'DUITNOW_QR', amount: 453 }],
        }),
      );

      expect(order.roundingAdjustment).toBe(0);
      expect(order.total).toBe(453);
    });
  });

  describe('tender and change', () => {
    it('gives change on an overpaid cash sale', async () => {
      const { variant } = await makeProduct({ outletId, price: 450 });

      const result = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 450 })],
          payments: [{ tender: 'CASH', amount: 1000 }],
        }),
      );

      expect(result.order.total).toBe(450);
      expect(result.change).toBe(550);
      await assertLedgerBalanced();
    });

    it('refuses to hand out cash change for an overpaid card sale', async () => {
      // Paying RM100 by card for a RM4.50 item and walking away with RM95.50
      // from the drawer is a cash-out machine, not a sale.
      const { variant } = await makeProduct({ outletId, price: 450 });

      await expect(
        orders.create(
          orderDto({
            outletId,
            registerId,
            staffId,
            lines: [line(variant, { unitPrice: 450 })],
            payments: [{ tender: 'CARD_MANUAL', amount: 10_000 }],
          }),
        ),
      ).rejects.toThrow(/overpay|exact/i);
    });

    it('refuses a negative payment amount', async () => {
      const { variant } = await makeProduct({ outletId, price: 450 });

      await expect(
        orders.create(
          orderDto({
            outletId,
            registerId,
            staffId,
            lines: [line(variant, { unitPrice: 450 })],
            payments: [
              { tender: 'CASH', amount: 900 },
              { tender: 'CASH', amount: -450 },
            ],
          }),
        ),
      ).rejects.toThrow(/amount/i);
    });
  });

  describe('the totals the request claimed', () => {
    it('records a mismatch so a stale offline receipt can be reconciled', async () => {
      // A terminal that sold from a cached catalog is not lying, it is stale.
      // The server still prices the sale, but the divergence has to be findable
      // later — the customer is holding a receipt with the other number on it.
      const { variant } = await makeProduct({ outletId, price: 500 });

      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 450 })], // yesterday's price
          payments: [{ tender: 'CASH', amount: 500 }],
          offline: true,
        }),
      );

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'PRICE_MISMATCH', entityId: order.id },
      });
      expect(audit).not.toBeNull();
      expect(audit!.detail).toMatchObject({ claimedTotal: 450, chargedTotal: 500 });
    });

    it('stays quiet when the terminal agreed with the server', async () => {
      const { variant } = await makeProduct({ outletId, price: 500 });

      const { order } = await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 500 })],
          payments: [{ tender: 'CASH', amount: 500 }],
        }),
      );

      expect(await prisma.auditLog.count({ where: { action: 'PRICE_MISMATCH', entityId: order.id } })).toBe(
        0,
      );
    });
  });

  describe('invariants that must survive re-pricing', () => {
    it('keeps the ledger balanced across a mixed basket', async () => {
      const a = await makeProduct({ outletId, price: 1080, taxCode: 'SST8' });
      const b = await makeProduct({ outletId, price: 4900, taxCode: 'ZRL' });

      await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [
            line(a.variant, { unitPrice: 1080, qty: 3 }),
            line(b.variant, { unitPrice: 4900, qty: 1, discount: 400 }),
          ],
          payments: [{ tender: 'CASH', amount: 10_000 }],
        }),
      );

      await assertLedgerBalanced();
    });

    it('still decrements stock by the quantity sold', async () => {
      const { variant } = await makeProduct({ outletId, price: 500, onHand: 10 });

      await orders.create(
        orderDto({
          outletId,
          registerId,
          staffId,
          lines: [line(variant, { unitPrice: 1, qty: 3 })],
          payments: [{ tender: 'CASH', amount: 1500 }],
        }),
      );

      const level = await prisma.inventoryLevel.findFirstOrThrow({ where: { variantId: variant.id } });
      expect(level.onHand).toBe(7);
    });

    it('is still idempotent on the offline retry key', async () => {
      const { variant } = await makeProduct({ outletId, price: 500 });
      const dto = orderDto({
        outletId,
        registerId,
        staffId,
        lines: [line(variant, { unitPrice: 500 })],
        payments: [{ tender: 'CASH', amount: 500 }],
      });

      const first = await orders.create(dto);
      const second = await orders.create(dto);

      expect(second.duplicate).toBe(true);
      expect(second.order.id).toBe(first.order.id);
      expect(await prisma.order.count()).toBe(1);
    });
  });
});
