import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from '@eiaaw/shared';
import { randomUUID } from 'crypto';

const TENDER_ACCOUNT: Record<string, string> = {
  CASH: 'TENDER_CASH',
  DUITNOW_QR: 'TENDER_DUITNOW',
  EWALLET_TNG: 'TENDER_EWALLET',
  EWALLET_GRABPAY: 'TENDER_EWALLET',
  EWALLET_BOOST: 'TENDER_EWALLET',
  CARD_TERMINAL: 'TENDER_CARD',
  CARD_MANUAL: 'TENDER_CARD',
  STRIPE: 'TENDER_STRIPE',
  ADYEN: 'TENDER_ADYEN',
  STORE_CREDIT: 'TENDER_STORE_CREDIT',
};

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  /**
   * Create a completed order. Idempotent on dto.idempotencyKey — safe for
   * offline sync retries. Runs inventory decrement + double-entry ledger
   * posting in one transaction.
   */
  async create(dto: CreateOrderDto) {
    const existing = await this.prisma.order.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existing) return { order: existing, duplicate: true };

    if (!dto.lines?.length) throw new BadRequestException('Order has no lines');

    const subtotal = dto.lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
    const lineDiscounts = dto.lines.reduce((s, l) => s + l.discount, 0);
    const discountTotal = lineDiscounts + (dto.cartDiscount ?? 0);
    const taxTotal = dto.lines.reduce((s, l) => s + l.taxAmount, 0);
    const total = subtotal - discountTotal + (dto.roundingAdjustment ?? 0);

    const paid = (dto.payments ?? []).reduce((s, p) => s + p.amount, 0);
    if (paid < total) {
      throw new BadRequestException(`Underpaid: total ${total} sen, tendered ${paid} sen`);
    }

    const orderNo = await this.nextOrderNo(dto.outletId);

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNo,
          idempotencyKey: dto.idempotencyKey,
          outletId: dto.outletId,
          registerId: dto.registerId || null,
          staffId: dto.staffId || null,
          customerId: dto.customerId || null,
          eventId: dto.eventId || null,
          status: 'COMPLETED',
          subtotal,
          discountTotal,
          taxTotal,
          roundingAdjustment: dto.roundingAdjustment ?? 0,
          total,
          offline: dto.offline ?? false,
          placedAt: dto.placedAt ? new Date(dto.placedAt) : new Date(),
          lines: {
            create: dto.lines.map((l) => ({
              variantId: l.variantId,
              name: l.name,
              sku: l.sku,
              qty: l.qty,
              unitPrice: l.unitPrice,
              discount: l.discount,
              taxCode: l.taxCode,
              taxAmount: l.taxAmount,
              total: l.unitPrice * l.qty - l.discount,
              notes: l.notes,
            })),
          },
          payments: {
            create: (dto.payments ?? []).map((p) => ({
              tender: p.tender,
              amount: p.amount,
              status: 'CAPTURED',
              provider: p.tender === 'CASH' ? 'CASH' : 'MOCK',
              providerRef: p.reference,
            })),
          },
        },
        include: { lines: true, payments: true },
      });

      // Inventory decrement + movement trail
      for (const l of dto.lines) {
        const level = await tx.inventoryLevel.findUnique({
          where: { outletId_variantId: { outletId: dto.outletId, variantId: l.variantId } },
        });
        if (level) {
          await tx.inventoryLevel.update({
            where: { id: level.id },
            data: { onHand: { decrement: l.qty } },
          });
        }
        await tx.stockMovement.create({
          data: {
            outletId: dto.outletId,
            variantId: l.variantId,
            qty: -l.qty,
            type: 'SALE',
            refId: created.id,
          },
        });
      }

      // Double-entry ledger: debit tender accounts, credit sales + tax payable
      const txnId = randomUUID();
      const netSales = total - taxTotal;
      const legs = [
        ...(dto.payments ?? []).map((p) => ({
          txnId,
          account: TENDER_ACCOUNT[p.tender] ?? 'TENDER_OTHER',
          debit: p.amount,
          credit: 0,
          refType: 'ORDER',
          refId: created.id,
        })),
        { txnId, account: 'SALES', debit: 0, credit: netSales, refType: 'ORDER', refId: created.id },
        ...(taxTotal > 0
          ? [{ txnId, account: 'TAX_PAYABLE', debit: 0, credit: taxTotal, refType: 'ORDER', refId: created.id }]
          : []),
        ...(paid > total
          ? [{ txnId, account: 'TENDER_CASH', debit: 0, credit: paid - total, refType: 'ORDER', refId: created.id }] // change given
          : []),
      ];
      await tx.ledgerEntry.createMany({ data: legs });

      // Queue consolidated e-invoice record (worker submits to MyInvois)
      await tx.eInvoice.create({
        data: { orderId: created.id, type: 'CONSOLIDATED', status: 'QUEUED' },
      });

      return created;
    });

    return { order, duplicate: false, change: paid - total };
  }

  list(outletId?: string, take = 50) {
    return this.prisma.order.findMany({
      where: outletId ? { outletId } : undefined,
      include: { lines: true, payments: true, customer: true },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  get(id: string) {
    return this.prisma.order.findUnique({
      where: { id },
      include: { lines: true, payments: true, customer: true, outlet: true },
    });
  }

  /** Void — manager-gated at controller level; restocks and reverses ledger */
  async void(id: string, userId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({ where: { id }, include: { lines: true, payments: true } });
      if (order.status !== 'COMPLETED') throw new BadRequestException('Only completed orders can be voided');
      await tx.order.update({ where: { id }, data: { status: 'VOIDED' } });
      for (const l of order.lines) {
        await tx.inventoryLevel.updateMany({
          where: { outletId: order.outletId, variantId: l.variantId },
          data: { onHand: { increment: l.qty } },
        });
        await tx.stockMovement.create({
          data: { outletId: order.outletId, variantId: l.variantId, qty: l.qty, type: 'REFUND', refId: id, reason },
        });
      }
      const txnId = randomUUID();
      await tx.ledgerEntry.createMany({
        data: [
          { txnId, account: 'REFUNDS', debit: order.total - order.taxTotal, credit: 0, refType: 'REFUND', refId: id },
          ...(order.taxTotal > 0
            ? [{ txnId, account: 'TAX_PAYABLE', debit: order.taxTotal, credit: 0, refType: 'REFUND', refId: id }]
            : []),
          ...order.payments.map((p) => ({
            txnId,
            account: TENDER_ACCOUNT[p.tender] ?? 'TENDER_OTHER',
            debit: 0,
            credit: p.amount,
            refType: 'REFUND',
            refId: id,
          })),
        ],
      });
      await tx.auditLog.create({
        data: { userId, action: 'VOID', entity: 'Order', entityId: id, detail: { reason } },
      });
      return { ok: true };
    });
  }

  private async nextOrderNo(outletId: string): Promise<string> {
    const today = new Date();
    const prefix = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(
      today.getDate(),
    ).padStart(2, '0')}`;
    const count = await this.prisma.order.count({
      where: { outletId, createdAt: { gte: new Date(today.toDateString()) } },
    });
    return `${prefix}-${String(count + 1).padStart(5, '0')}-${outletId.slice(-4)}`;
  }
}
