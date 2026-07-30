import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

  async adjust(params: { outletId: string; variantId: string; qty: number; type: string; reason?: string }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.inventoryLevel.upsert({
        where: { outletId_variantId: { outletId: params.outletId, variantId: params.variantId } },
        update: { onHand: { increment: params.qty } },
        create: { outletId: params.outletId, variantId: params.variantId, onHand: params.qty },
      });
      return tx.stockMovement.create({
        data: {
          outletId: params.outletId,
          variantId: params.variantId,
          qty: params.qty,
          type: params.type,
          reason: params.reason,
        },
      });
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
