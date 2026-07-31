import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaxService } from '../catalog/tax.service';
import { DiscountAuthorityService } from './discount-authority.service';
import { CreateOrderDto, MONEY, TAX, businessDate, discountDemand } from '@eiaaw/shared';
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

/**
 * An order transaction takes a row lock on the outlet's sequence for its whole
 * duration, so every concurrent sale at one outlet queues behind it. The
 * default 5s ceiling is comfortable for a quiet shop and far too tight for a
 * merchandise counter at an event, where the queue is the normal state.
 */
const ORDER_TX_OPTIONS = { maxWait: 15_000, timeout: 30_000 } as const;

/** A line after the server has priced it. The request's own numbers are gone by here. */
type PricedLine = {
  variantId: string;
  name: string;
  sku: string;
  qty: number;
  unitPrice: number;
  discount: number;
  taxCode: string;
  taxAmount: number;
  total: number;
  notes?: string;
};

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private tax: TaxService,
    private discounts: DiscountAuthorityService,
  ) {}

  /**
   * Create a completed order. Idempotent on dto.idempotencyKey — safe for
   * offline sync retries. Runs inventory decrement + double-entry ledger
   * posting in one transaction.
   *
   * The request is a statement of intent, not of price. Which items, how many,
   * what was tendered — those come from the terminal. What they cost, what tax
   * they carry and how the cash total rounds are all recomputed here from the
   * catalog, because the terminal is hardware in a merchant's shop on a network
   * anyone in the venue shares, and its request body is two keystrokes away in
   * any browser's devtools.
   */
  async create(dto: CreateOrderDto) {
    const existing = await this.prisma.order.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existing) return { order: existing, duplicate: true };

    if (!dto.lines?.length) throw new BadRequestException('Order has no lines');

    const outlet = await this.prisma.outlet.findUnique({ where: { id: dto.outletId } });
    if (!outlet) throw new BadRequestException(`Unknown outlet ${dto.outletId}`);

    const payments = this.validatePayments(dto);
    // One instant for the whole sale, so a rate that changes between two lines
    // of the same basket cannot apply to only some of them.
    const at = new Date();
    const { lines, subtotal, discountTotal, taxTotal, demand } = await this.priceLines(dto, at);

    // Bounded and audited was never the same as allowed: until this check, any
    // holder of a valid token could take money off a sale up to the value of
    // the line, and the audit log would faithfully record that they had.
    const { approvedById } = await this.discounts.authorise({
      demand,
      sellerId: dto.staffId || null,
      registerId: dto.registerId || null,
      pin: dto.discountApprovalPin,
    });

    const netTotal = subtotal - discountTotal;
    // BNM 5-sen rounding is a property of settling in coins. An order paid by
    // card or QR settles to the sen, so it does not round — and a rounding
    // adjustment the terminal asked for is never taken on trust either way.
    const cashOnly = payments.length > 0 && payments.every((p) => p.tender === 'CASH');
    const roundingAdjustment = cashOnly ? MONEY.cashRounding(netTotal) : 0;
    const total = netTotal + roundingAdjustment;

    const paid = payments.reduce((s, p) => s + p.amount, 0);
    if (paid < total) {
      throw new BadRequestException(`Underpaid: total ${total} sen, tendered ${paid} sen`);
    }
    // Change comes out of the drawer, so only cash may be over-tendered. An
    // electronic tender that "overpays" is a way to walk out with the
    // difference in notes.
    const electronicPaid = payments.filter((p) => p.tender !== 'CASH').reduce((s, p) => s + p.amount, 0);
    if (electronicPaid > total) {
      throw new BadRequestException(
        `Electronic tenders must settle the exact amount — overpaid by ${electronicPaid - total} sen`,
      );
    }
    const change = paid - total;

    // The shift open on this register right now owns the cash. Null means the
    // sale happened outside any shift, which is audited below: that cash can
    // never be reconciled at cash-up.
    const shift = dto.registerId
      ? await this.prisma.shift.findUnique({ where: { activeRegisterId: dto.registerId } })
      : null;

    const claimedTotal = this.claimedTotal(dto);
    const takesCash = payments.some((p) => p.tender === 'CASH');

    const order = await this.prisma.$transaction(async (tx) => {
      const orderNo = await this.allocateOrderNo(tx, outlet.id, outlet.timezone);

      const created = await tx.order.create({
        data: {
          orderNo,
          idempotencyKey: dto.idempotencyKey,
          outletId: dto.outletId,
          registerId: dto.registerId || null,
          staffId: dto.staffId || null,
          discountApprovedById: approvedById,
          customerId: dto.customerId || null,
          shiftId: shift?.id ?? null,
          eventId: dto.eventId || null,
          status: 'COMPLETED',
          subtotal,
          discountTotal,
          taxTotal,
          roundingAdjustment,
          total,
          offline: dto.offline ?? false,
          placedAt: dto.placedAt ? new Date(dto.placedAt) : new Date(),
          lines: { create: lines },
          payments: {
            create: payments.map((p) => ({
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
      for (const l of lines) {
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

      // Double-entry ledger: debit tender accounts, credit sales + tax payable.
      // Every leg carries the shift, so cash-up can scope the drawer to the one
      // till instead of guessing from timestamps.
      const txnId = randomUUID();
      const where = {
        shiftId: shift?.id ?? null,
        outletId: dto.outletId,
        registerId: dto.registerId || null,
      };
      const netSales = total - taxTotal;
      const legs = [
        ...payments.map((p) => ({
          txnId,
          account: TENDER_ACCOUNT[p.tender] ?? 'TENDER_OTHER',
          debit: p.amount,
          credit: 0,
          refType: 'ORDER',
          refId: created.id,
          ...where,
        })),
        {
          txnId,
          account: 'SALES',
          debit: 0,
          credit: netSales,
          refType: 'ORDER',
          refId: created.id,
          ...where,
        },
        ...(taxTotal !== 0
          ? [
              {
                txnId,
                account: 'TAX_PAYABLE',
                debit: 0,
                credit: taxTotal,
                refType: 'ORDER',
                refId: created.id,
                ...where,
              },
            ]
          : []),
        ...(change > 0
          ? [
              {
                txnId,
                account: 'TENDER_CASH',
                debit: 0,
                credit: change,
                refType: 'ORDER',
                refId: created.id,
                ...where,
              },
            ]
          : []),
      ];
      await tx.ledgerEntry.createMany({ data: legs });

      // Queue consolidated e-invoice record (worker submits to MyInvois)
      await tx.eInvoice.create({
        data: { orderId: created.id, type: 'CONSOLIDATED', status: 'QUEUED' },
      });

      const trail: { action: string; detail: Prisma.InputJsonObject; userId?: string | null }[] = [];
      if (discountTotal > 0) {
        trail.push({
          action: 'DISCOUNT',
          detail: {
            discountTotal,
            cartDiscount: dto.cartDiscount ?? 0,
            subtotal,
            total,
            percentBps: demand.percentBps,
          },
        });
      }
      if (approvedById) {
        // Attributed to the approver, not the seller: the question this answers
        // later is who allowed it, and the seller is already on the order.
        trail.push({
          action: 'DISCOUNT_OVERRIDE',
          userId: approvedById,
          detail: {
            requestedById: dto.staffId ?? null,
            discountTotal,
            percentBps: demand.percentBps,
            subtotal,
          },
        });
      }
      if (claimedTotal !== null && claimedTotal !== total) {
        // Not necessarily an attack: a terminal that sold from a cached catalog
        // is stale, not dishonest. Either way the customer is holding a receipt
        // with the other number printed on it, so the divergence has to be
        // findable later.
        trail.push({
          action: 'PRICE_MISMATCH',
          detail: { claimedTotal, chargedTotal: total, offline: dto.offline ?? false },
        });
      }
      if (takesCash && !shift) {
        trail.push({
          action: 'CASH_OUTSIDE_SHIFT',
          detail: { registerId: dto.registerId ?? null, amount: paid },
        });
      }
      if (trail.length) {
        await tx.auditLog.createMany({
          data: trail.map((t) => ({
            userId: t.userId !== undefined ? t.userId : dto.staffId || null,
            action: t.action,
            entity: 'Order',
            entityId: created.id,
            detail: t.detail,
          })),
        });
      }

      return created;
    }, ORDER_TX_OPTIONS);

    return { order, duplicate: false, change };
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
      const order = await tx.order.findUniqueOrThrow({
        where: { id },
        include: { lines: true, payments: true },
      });
      if (order.status !== 'COMPLETED') throw new BadRequestException('Only completed orders can be voided');
      await tx.order.update({ where: { id }, data: { status: 'VOIDED' } });
      for (const l of order.lines) {
        await tx.inventoryLevel.updateMany({
          where: { outletId: order.outletId, variantId: l.variantId },
          data: { onHand: { increment: l.qty } },
        });
        await tx.stockMovement.create({
          data: {
            outletId: order.outletId,
            variantId: l.variantId,
            qty: l.qty,
            type: 'REFUND',
            refId: id,
            reason,
          },
        });
      }

      // The refund leaves the drawer that is open *now*, not the one that took
      // the sale — which may have cashed up hours ago.
      const shift = order.registerId
        ? await tx.shift.findUnique({ where: { activeRegisterId: order.registerId } })
        : null;
      const where = {
        shiftId: shift?.id ?? null,
        outletId: order.outletId,
        registerId: order.registerId,
      };

      const txnId = randomUUID();
      await tx.ledgerEntry.createMany({
        data: [
          {
            txnId,
            account: 'REFUNDS',
            debit: order.total - order.taxTotal,
            credit: 0,
            refType: 'REFUND',
            refId: id,
            ...where,
          },
          ...(order.taxTotal !== 0
            ? [
                {
                  txnId,
                  account: 'TAX_PAYABLE',
                  debit: order.taxTotal,
                  credit: 0,
                  refType: 'REFUND',
                  refId: id,
                  ...where,
                },
              ]
            : []),
          ...this.reversalTenderLegs(order).map((leg) => ({
            txnId,
            account: leg.account,
            debit: 0,
            credit: leg.credit,
            refType: 'REFUND',
            refId: id,
            ...where,
          })),
        ],
      });
      await tx.auditLog.create({
        data: { userId, action: 'VOID', entity: 'Order', entityId: id, detail: { reason } },
      });
      return { ok: true };
    });
  }

  // ── pricing ────────────────────────────────────────────────────────────────

  /**
   * Re-price every line from the catalog and apportion any cart-level discount
   * across them, so that `sum(line.total)` always reconciles to
   * `subtotal - discountTotal` and the tax on each line matches the money that
   * line actually took.
   */
  private async priceLines(dto: CreateOrderDto, at: Date) {
    const ids = [...new Set(dto.lines.map((l) => l.variantId))];
    const variants = await this.prisma.variant.findMany({
      where: { id: { in: ids } },
      include: { product: true },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));

    // Pass 1: catalog price and line-level discount.
    const priced = dto.lines.map((l) => {
      const variant = byId.get(l.variantId);
      if (!variant) throw new BadRequestException(`Unknown variant ${l.variantId}`);
      if (!variant.active || !variant.product.active) {
        throw new BadRequestException(`${variant.name} is inactive and cannot be sold`);
      }

      const qty = l.qty;
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new BadRequestException(`Invalid quantity ${qty} for ${variant.name}`);
      }

      const lineDiscount = l.discount ?? 0;
      const gross = variant.price * qty;
      if (!Number.isInteger(lineDiscount) || lineDiscount < 0) {
        throw new BadRequestException(`Invalid discount ${lineDiscount} on ${variant.name}`);
      }
      if (lineDiscount > gross) {
        throw new BadRequestException(
          `Discount ${lineDiscount} exceeds the ${gross} sen line for ${variant.name}`,
        );
      }

      return { variant, qty, gross, lineDiscount, notes: l.notes, net: gross - lineDiscount };
    });

    const subtotal = priced.reduce((s, p) => s + p.gross, 0);
    const lineDiscounts = priced.reduce((s, p) => s + p.lineDiscount, 0);
    const netAfterLines = subtotal - lineDiscounts;

    const cartDiscount = dto.cartDiscount ?? 0;
    if (!Number.isInteger(cartDiscount) || cartDiscount < 0) {
      throw new BadRequestException(`Invalid cart discount ${cartDiscount}`);
    }
    if (cartDiscount > netAfterLines) {
      throw new BadRequestException(`Cart discount ${cartDiscount} exceeds the ${netAfterLines} sen cart`);
    }

    // Pass 2: spread the cart discount pro-rata, and give the rounding residue
    // to the largest line so the parts sum exactly back to the whole.
    const shares = this.apportion(
      cartDiscount,
      priced.map((p) => p.net),
    );

    // One lookup for the whole basket, at the moment of sale — a rate change
    // mid-shift must not land halfway through a cart.
    const rates = await this.tax.ratesFor(
      priced.map((p) => p.variant.product.taxCode),
      at,
    );

    const lines: PricedLine[] = priced.map((p, i) => {
      const discount = p.lineDiscount + shares[i];
      const total = p.gross - discount;
      const taxCode = p.variant.product.taxCode;
      return {
        variantId: p.variant.id,
        name: p.variant.name,
        sku: p.variant.sku,
        qty: p.qty,
        unitPrice: p.variant.price,
        discount,
        taxCode,
        taxAmount: TAX.inclusiveComponent(total, rates.get(taxCode)!),
        total,
        notes: p.notes,
      };
    });

    return {
      lines,
      subtotal,
      discountTotal: lineDiscounts + cartDiscount,
      taxTotal: lines.reduce((s, l) => s + l.taxAmount, 0),
      // Kept unapportioned for the authority check: whether a discount needs
      // signing off is about what was asked for, not how it was spread.
      demand: discountDemand(
        priced.map((p) => ({ gross: p.gross, discount: p.lineDiscount })),
        cartDiscount,
      ),
    };
  }

  /**
   * Split `amount` across `weights` so the parts are proportional and sum
   * exactly to the whole. Largest-remainder: floor every share, then hand the
   * leftover sen out to the lines that lost the most in the flooring.
   */
  private apportion(amount: number, weights: number[]): number[] {
    if (amount === 0) return weights.map(() => 0);
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    if (totalWeight === 0) return weights.map(() => 0);

    const exact = weights.map((w) => (amount * w) / totalWeight);
    const shares = exact.map(Math.floor);
    let residue = amount - shares.reduce((s, v) => s + v, 0);

    const byRemainder = exact
      .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
      .sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; residue > 0; i = (i + 1) % byRemainder.length) {
      shares[byRemainder[i].index] += 1;
      residue -= 1;
    }
    return shares;
  }

  private validatePayments(dto: CreateOrderDto) {
    const payments = dto.payments ?? [];
    for (const p of payments) {
      if (!Number.isInteger(p.amount) || p.amount < 0) {
        throw new BadRequestException(`Invalid payment amount ${p.amount} for ${p.tender}`);
      }
    }
    return payments;
  }

  /**
   * The total the terminal believed it was charging, reconstructed from the
   * request. Null when the request's own numbers are not arithmetic — there is
   * then nothing meaningful to compare against.
   */
  private claimedTotal(dto: CreateOrderDto): number | null {
    const lines = dto.lines.reduce((s, l) => s + l.unitPrice * l.qty - (l.discount ?? 0), 0);
    const claimed = lines - (dto.cartDiscount ?? 0) + (dto.roundingAdjustment ?? 0);
    return Number.isFinite(claimed) ? claimed : null;
  }

  // ── numbering ──────────────────────────────────────────────────────────────

  /**
   * Reserve the next receipt number for the outlet's trading day.
   *
   * One statement, so concurrent sales serialise on the sequence row instead of
   * racing: `INSERT … ON CONFLICT DO UPDATE` takes the row lock, increments, and
   * returns the value it wrote. The predecessor read `COUNT(*) + 1` outside the
   * transaction, which hands the same number to every terminal that reads it in
   * the same moment — all but one of them then losing to the unique index, as a
   * failed sale, at the counter, during the busiest minute of the day.
   *
   * Called inside the order transaction so a rolled-back order gives its number
   * back rather than leaving a gap in the receipt run.
   *
   * The first allocation of an outlet's day seeds itself from the receipt
   * numbers already issued that day rather than starting at 1. Any deployment
   * that has traded before this code shipped has orders numbered by the old
   * count-based scheme and nothing wrote them into the sequence — so starting
   * at 1 collides with a number already printed on a customer's receipt, and
   * the first sale after the upgrade fails at the counter. The scan runs once
   * per outlet per day; every subsequent sale takes the ON CONFLICT path.
   */
  private async allocateOrderNo(
    tx: {
      $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
    },
    outletId: string,
    timezone: string,
  ): Promise<string> {
    const date = businessDate(new Date(), timezone);
    const prefix = date.replace(/-/g, '');
    const rows = await tx.$queryRaw<{ lastValue: number }[]>`
      INSERT INTO "OrderSequence" ("id", "outletId", "businessDate", "lastValue")
      VALUES (
        ${randomUUID()},
        ${outletId},
        ${date},
        COALESCE(
          (
            SELECT MAX(split_part("orderNo", '-', 2)::int)
            FROM "Order"
            WHERE "outletId" = ${outletId}
              -- Anchored to this outlet's day, and to the shape we can parse:
              -- an offline terminal prints LOCAL-xxxxxxxx, which has no
              -- sequence in it and would fail the cast.
              AND "orderNo" ~ ${`^${prefix}-[0-9]{5}-`}
          ),
          0
        ) + 1
      )
      ON CONFLICT ("outletId", "businessDate")
      DO UPDATE SET "lastValue" = "OrderSequence"."lastValue" + 1
      RETURNING "lastValue"`;

    const sequence = rows[0].lastValue;
    return `${prefix}-${String(sequence).padStart(5, '0')}-${outletId.slice(-4)}`;
  }

  /**
   * Tender legs for a reversal, crediting back what the till actually kept.
   *
   * Change handed over the counter was never the merchant's, so reversing the
   * full amount tendered credits money that already walked out of the door —
   * and leaves the transaction's credits exceeding its debits, which is a
   * ledger that no longer balances.
   */
  private reversalTenderLegs(order: {
    total: number;
    payments: { tender: string; amount: number }[];
  }): { account: string; credit: number }[] {
    let change = order.payments.reduce((s, p) => s + p.amount, 0) - order.total;
    const legs: { account: string; credit: number }[] = [];
    for (const p of order.payments) {
      let credit = p.amount;
      if (change > 0 && p.tender === 'CASH') {
        const taken = Math.min(credit, change);
        credit -= taken;
        change -= taken;
      }
      if (credit > 0) {
        legs.push({ account: TENDER_ACCOUNT[p.tender] ?? 'TENDER_OTHER', credit });
      }
    }
    return legs;
  }
}
