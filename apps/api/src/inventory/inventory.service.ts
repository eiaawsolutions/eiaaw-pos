import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The movement types the trail is read back with. Free text here is a lost row. */
const MOVEMENT_TYPES = new Set(['RECEIVE', 'ADJUST', 'TRANSFER_IN', 'TRANSFER_OUT', 'STOCKTAKE', 'WASTAGE']);

/**
 * A single adjustment past this is a stocktake, not a correction. The ceiling
 * exists so a slipped digit is refused rather than absorbed.
 */
const MAX_ADJUSTMENT = 100_000;

@Injectable()
export class InventoryService {
  constructor(private prisma: PrismaService) {}

  levels(outletId: string) {
    return this.prisma.inventoryLevel.findMany({
      where: { outletId },
      include: { variant: { include: { product: true } } },
      orderBy: { onHand: 'asc' },
    });
  }

  lowStock(outletId: string) {
    return this.prisma
      .$queryRaw`SELECT il.*, v.sku, v.name FROM "InventoryLevel" il JOIN "Variant" v ON v.id = il."variantId" WHERE il."outletId" = ${outletId} AND il."onHand" <= il."reorderAt"`;
  }

  /**
   * Move stock, and leave a trail saying who moved it.
   *
   * Manager-gated at the controller, but the gate only asked who was calling —
   * not what they were asking for. Quantity and movement type both arrived
   * unchecked, so a typo or a curious request could write a free-text movement
   * type nothing downstream understands, or drive a level to an arbitrary
   * number in one call.
   */
  async adjust(params: {
    outletId: string;
    variantId: string;
    qty: number;
    type: string;
    reason?: string;
    userId?: string;
  }) {
    if (!Number.isInteger(params.qty) || params.qty === 0) {
      throw new BadRequestException('Adjustment quantity must be a non-zero whole number');
    }
    if (Math.abs(params.qty) > MAX_ADJUSTMENT) {
      throw new BadRequestException(
        `Adjustment of ${params.qty} exceeds the ${MAX_ADJUSTMENT} unit limit — split it, or correct the stocktake`,
      );
    }
    if (!MOVEMENT_TYPES.has(params.type)) {
      throw new BadRequestException(`Unknown stock movement type "${params.type}"`);
    }
    const variant = await this.prisma.variant.findUnique({ where: { id: params.variantId } });
    if (!variant) throw new BadRequestException(`Unknown variant ${params.variantId}`);

    return this.prisma.$transaction(async (tx) => {
      const level = await tx.inventoryLevel.upsert({
        where: { outletId_variantId: { outletId: params.outletId, variantId: params.variantId } },
        update: { onHand: { increment: params.qty } },
        create: { outletId: params.outletId, variantId: params.variantId, onHand: params.qty },
      });

      // Stock that has gone negative is a counting error, not a fact about the
      // world, and it silently corrupts every reorder decision downstream.
      if (level.onHand < 0) {
        throw new BadRequestException(
          `That would leave ${level.onHand} of ${variant.sku} on hand — count it and use a stocktake instead`,
        );
      }

      const movement = await tx.stockMovement.create({
        data: {
          outletId: params.outletId,
          variantId: params.variantId,
          qty: params.qty,
          type: params.type,
          reason: params.reason,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: params.userId ?? null,
          action: 'STOCK_ADJUST',
          entity: 'StockMovement',
          entityId: movement.id,
          detail: {
            outletId: params.outletId,
            variantId: params.variantId,
            sku: variant.sku,
            qty: params.qty,
            type: params.type,
            onHandAfter: level.onHand,
            reason: params.reason ?? null,
          },
        },
      });
      return movement;
    });
  }

  movements(outletId: string, variantId?: string) {
    return this.prisma.stockMovement.findMany({
      where: { outletId, ...(variantId ? { variantId } : {}) },
      include: { variant: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
}
