import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { prisma } from './setup';
import { makeOutlet, makeProduct, makeUser, seedTaxCodes } from './fixtures';
import { InventoryService } from '../src/inventory/inventory.service';

/**
 * Stock adjustments are manager-gated, but the gate only ever asked who was
 * calling — never what they were asking for. Quantity and movement type both
 * arrived unchecked.
 */
describe('inventory — adjustments', () => {
  let inventory: InventoryService;
  let outletId: string;
  let userId: string;
  let variant: { id: string; sku: string };

  beforeEach(async () => {
    await seedTaxCodes();
    inventory = new InventoryService(prisma as never);
    outletId = (await makeOutlet()).id;
    userId = (await makeUser({ role: 'MANAGER' })).id;
    variant = (await makeProduct({ outletId, price: 1000, onHand: 20 })).variant;
  });

  const adjust = (over: Partial<Parameters<InventoryService['adjust']>[0]> = {}) =>
    inventory.adjust({ outletId, variantId: variant.id, qty: 5, type: 'ADJUST', userId, ...over });

  it('moves stock and records the movement', async () => {
    await adjust({ qty: 7 });
    const level = await prisma.inventoryLevel.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(level.onHand).toBe(27);
  });

  it('takes stock away too', async () => {
    await adjust({ qty: -5 });
    const level = await prisma.inventoryLevel.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(level.onHand).toBe(15);
  });

  it('refuses to leave stock negative', async () => {
    // Negative stock is a counting error, not a fact about the world, and it
    // quietly corrupts every reorder decision downstream.
    await expect(adjust({ qty: -50 })).rejects.toThrow(/on hand|stocktake/i);

    const level = await prisma.inventoryLevel.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(level.onHand).toBe(20);
    expect(await prisma.stockMovement.count()).toBe(0);
  });

  it('refuses a quantity that is not a non-zero whole number', async () => {
    for (const qty of [0, 1.5, Number.NaN]) {
      await expect(adjust({ qty })).rejects.toThrow(BadRequestException);
    }
  });

  it('refuses an implausibly large adjustment', async () => {
    // A slipped digit should be refused, not absorbed.
    await expect(adjust({ qty: 10_000_000 })).rejects.toThrow(/limit|exceeds/i);
  });

  it('refuses a movement type the trail cannot be read back with', async () => {
    await expect(adjust({ type: 'SHRINKAGE_MAYBE' })).rejects.toThrow(/movement type/i);
  });

  it('accepts the movement types stock reporting knows about', async () => {
    for (const type of ['RECEIVE', 'ADJUST', 'STOCKTAKE', 'WASTAGE', 'TRANSFER_IN', 'TRANSFER_OUT']) {
      await expect(adjust({ qty: 1, type })).resolves.toBeTruthy();
    }
  });

  it('refuses a variant that does not exist', async () => {
    await expect(adjust({ variantId: 'no-such-variant' })).rejects.toThrow(/unknown variant/i);
  });

  it('says who moved the stock', async () => {
    // Manager-gated means somebody is accountable; the trail has to name them.
    const movement = await adjust({ qty: 3, reason: 'found in the back' });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'STOCK_ADJUST', entityId: movement.id },
    });
    expect(audit.userId).toBe(userId);
    expect(audit.detail).toMatchObject({
      sku: variant.sku,
      qty: 3,
      onHandAfter: 23,
      reason: 'found in the back',
    });
  });

  it('leaves nothing behind when it refuses', async () => {
    await expect(adjust({ qty: -999 })).rejects.toThrow();
    expect(await prisma.stockMovement.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'STOCK_ADJUST' } })).toBe(0);
  });
});
