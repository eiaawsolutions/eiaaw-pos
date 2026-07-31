import { describe, it, expect, beforeEach } from 'vitest';
import * as bcrypt from 'bcryptjs';
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
import type { OrdersService } from '../src/orders/orders.service';

/**
 * A discount is money leaving the till, and until now anyone holding a valid
 * token could take it — bounded by the line total and written to the audit log,
 * which records who did it without ever having asked whether they could.
 *
 * The rule is enforced here rather than at the terminal for the same reason
 * prices are: the terminal is hardware on a shop floor and its request body is
 * a few keystrokes away in any browser's devtools.
 */
describe('discounts — authority', () => {
  let orders: OrdersService;
  let outletId: string;
  let registerId: string;
  let cashierId: string;
  let variant: { id: string; sku: string; name: string };

  const MANAGER_PIN = '778899';

  beforeEach(async () => {
    await seedPolicyDefaults();
    orders = ordersService();

    outletId = (await makeOutlet()).id;
    registerId = (await makeRegister(outletId)).id;
    cashierId = (await makeUser({ role: 'CASHIER' })).id;
    variant = (await makeProduct({ outletId, price: 10_000, taxCode: 'ZRL' })).variant;
  });

  async function makeManager(pin = MANAGER_PIN, role = 'MANAGER') {
    return prisma.user.create({
      data: {
        name: 'Duty Manager',
        email: `mgr-${Math.abs(pin.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7))}@example.test`,
        passwordHash: 'not-a-real-hash',
        pin: await bcrypt.hash(pin, 10),
        role,
      },
    });
  }

  function sale(opts: { discount?: number; cartDiscount?: number; pin?: string; staffId?: string }) {
    const discount = opts.discount ?? 0;
    const cartDiscount = opts.cartDiscount ?? 0;
    return orders.create({
      ...orderDto({
        outletId,
        registerId,
        staffId: opts.staffId ?? cashierId,
        lines: [line(variant, { unitPrice: 10_000, discount })],
        cartDiscount,
        // Clamped at zero: a discount larger than the sale is refused on its
        // own terms, and a negative tender would trip a different check first.
        payments: [{ tender: 'CARD_MANUAL', amount: Math.max(0, 10_000 - discount - cartDiscount) }],
      }),
      discountApprovalPin: opts.pin,
    });
  }

  describe('within the limit the seller already has', () => {
    it('lets a cashier give a discount inside their ceiling, unaided', async () => {
      // Seeded cashier authority is 10% and RM50.
      const { order } = await sale({ discount: 500 }); // 5%, RM5
      expect(order.discountTotal).toBe(500);
      expect(order.discountApprovedById).toBeNull();
    });

    it('needs no approval when nothing is discounted', async () => {
      const { order } = await sale({});
      expect(order.discountTotal).toBe(0);
      expect(order.discountApprovedById).toBeNull();
    });
  });

  describe('beyond it', () => {
    it('refuses a discount over the percentage ceiling with no approval', async () => {
      await expect(sale({ discount: 5000 })).rejects.toThrow(/approval|authoris/i);
      expect(await prisma.order.count()).toBe(0);
    });

    it('refuses one over the absolute ceiling even at a modest percentage', async () => {
      // 8% of a RM1,000 basket is RM80, past the cashier's RM50 ceiling.
      const big = (await makeProduct({ outletId, price: 100_000, taxCode: 'ZRL' })).variant;
      await expect(
        orders.create(
          orderDto({
            outletId,
            registerId,
            staffId: cashierId,
            lines: [line(big, { unitPrice: 100_000, discount: 8000 })],
            payments: [{ tender: 'CARD_MANUAL', amount: 92_000 }],
          }),
        ),
      ).rejects.toThrow(/approval|authoris/i);
    });

    it('allows it against a manager PIN, and records who approved', async () => {
      const manager = await makeManager();

      const { order } = await sale({ discount: 5000, pin: MANAGER_PIN });

      expect(order.discountTotal).toBe(5000);
      expect(order.discountApprovedById).toBe(manager.id);
      expect(order.staffId).toBe(cashierId);
    });

    it('writes the override to the audit trail with both people on it', async () => {
      const manager = await makeManager();
      const { order } = await sale({ discount: 5000, pin: MANAGER_PIN });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'DISCOUNT_OVERRIDE', entityId: order.id },
      });
      expect(audit.userId).toBe(manager.id);
      expect(audit.detail).toMatchObject({ requestedById: cashierId, discountTotal: 5000 });
    });

    it('rejects a PIN that belongs to nobody', async () => {
      await makeManager();
      await expect(sale({ discount: 5000, pin: '000000' })).rejects.toThrow(/approval|authoris/i);
      expect(await prisma.order.count()).toBe(0);
    });

    it('rejects a valid PIN whose owner has no more authority than the seller', async () => {
      // Another cashier cannot wave through what a cashier could not do.
      await prisma.user.create({
        data: {
          name: 'Other Cashier',
          email: 'other@example.test',
          passwordHash: 'x',
          pin: await bcrypt.hash('222222', 10),
          role: 'CASHIER',
        },
      });

      await expect(sale({ discount: 5000, pin: '222222' })).rejects.toThrow(/approval|authoris/i);
    });

    it('rejects the PIN of a deactivated manager', async () => {
      const manager = await makeManager();
      await prisma.user.update({ where: { id: manager.id }, data: { active: false } });

      await expect(sale({ discount: 5000, pin: MANAGER_PIN })).rejects.toThrow(/approval|authoris/i);
    });

    it('still refuses a discount nobody has the authority for', async () => {
      // An owner may take 100%, but not more than the sale is worth — that is
      // the line-total bound, which authority does not override.
      await makeManager('555555', 'OWNER');
      await expect(sale({ discount: 20_000, pin: '555555' })).rejects.toThrow(/discount/i);
    });

    it('does not leak whether a PIN was wrong or merely unprivileged', async () => {
      // Two different failures must read the same from outside, or the terminal
      // becomes an oracle for which PINs are real.
      await makeManager();
      await prisma.user.create({
        data: {
          name: 'Other Cashier',
          email: 'other2@example.test',
          passwordHash: 'x',
          pin: await bcrypt.hash('333333', 10),
          role: 'CASHIER',
        },
      });

      const wrong = await sale({ discount: 5000, pin: '000000' }).catch((e) => e.message);
      const unprivileged = await sale({ discount: 5000, pin: '333333' }).catch((e) => e.message);
      expect(wrong).toBe(unprivileged);
    });
  });

  describe('against a PIN being ground down', () => {
    it('locks the register out after repeated failures', async () => {
      await makeManager();

      for (let i = 0; i < 5; i++) {
        await sale({ discount: 5000, pin: '111000' }).catch(() => undefined);
      }

      // Even the correct PIN is refused while the lockout stands.
      await expect(sale({ discount: 5000, pin: MANAGER_PIN })).rejects.toThrow(/too many|locked/i);
    });

    it('counts failures per register, so one till cannot lock out the shop', async () => {
      await makeManager();
      const other = await makeRegister(outletId);

      for (let i = 0; i < 5; i++) {
        await sale({ discount: 5000, pin: '111000' }).catch(() => undefined);
      }

      const { order } = await orders.create({
        ...orderDto({
          outletId,
          registerId: other.id,
          staffId: cashierId,
          lines: [line(variant, { unitPrice: 10_000, discount: 5000 })],
          payments: [{ tender: 'CARD_MANUAL', amount: 5000 }],
        }),
        discountApprovalPin: MANAGER_PIN,
      });
      expect(order.discountTotal).toBe(5000);
    });

    it('leaves every attempt on the record, successful or not', async () => {
      await makeManager();
      await sale({ discount: 5000, pin: '111000' }).catch(() => undefined);
      await sale({ discount: 5000, pin: MANAGER_PIN });

      const attempts = await prisma.approvalAttempt.findMany({ orderBy: { createdAt: 'asc' } });
      expect(attempts.map((a) => a.success)).toEqual([false, true]);
      expect(attempts[1].approverId).not.toBeNull();
      expect(attempts[0].approverId).toBeNull();
    });
  });

  describe('the policy itself', () => {
    it('is data, so raising a ceiling needs no deploy', async () => {
      await expect(sale({ discount: 5000 })).rejects.toThrow(/approval|authoris/i);

      await prisma.discountPolicy.update({
        where: { role: 'CASHIER' },
        data: { maxPercentBps: 6000, maxAmountSen: 100_000 },
      });

      const { order } = await sale({ discount: 5000 });
      expect(order.discountTotal).toBe(5000);
    });

    it('gives a role with no policy row no authority at all', async () => {
      await prisma.discountPolicy.delete({ where: { role: 'CASHIER' } });
      await expect(sale({ discount: 1 })).rejects.toThrow(/approval|authoris/i);
    });

    it('measures a cart discount against the whole cart', async () => {
      const { order } = await sale({ cartDiscount: 900 }); // 9%, RM9 — inside 10%/RM50
      expect(order.discountTotal).toBe(900);

      await expect(sale({ cartDiscount: 2000 })).rejects.toThrow(/approval|authoris/i);
    });
  });
});
