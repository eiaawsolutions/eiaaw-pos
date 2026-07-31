import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentIntentResult, PaymentProvider } from './providers/provider.interface';
import { MockDuitNowProvider } from './providers/mock.provider';

/** One answer for every way a webhook can be rejected. */
const WEBHOOK_REFUSED = 'Webhook rejected';

/** Statuses a PSP may move a payment into. Anything else is not ours to apply. */
const ACCEPTED_STATUSES = new Set(['AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED']);

/** Once here, a payment does not move again on a PSP's say-so. */
const TERMINAL_STATUSES = new Set(['REFUNDED', 'CANCELLED']);

@Injectable()
export class PaymentsService {
  private providers: Record<string, PaymentProvider>;

  constructor(private prisma: PrismaService) {
    const mock = new MockDuitNowProvider();
    // Route each tender to a provider. v1.0: replace MOCK with Fiuu/eGHL
    // adapter (single contract covers DuitNow QR + TNG/GrabPay/Boost) and
    // add Stripe/Adyen adapters for global rails.
    this.providers = {
      DUITNOW_QR: mock,
      EWALLET_TNG: mock,
      EWALLET_GRABPAY: mock,
      EWALLET_BOOST: mock,
      STRIPE: mock,
      ADYEN: mock,
    };
  }

  /**
   * Start a non-cash payment: returns QR payload / redirect for the terminal.
   *
   * One return type across both branches. It used to be a union of the
   * provider's result and an ad-hoc object literal, so anything reading
   * `qrPayload` off the result did not typecheck at the call site — which is
   * the sort of thing a caller works around rather than reports.
   */
  async createIntent(body: {
    tender: string;
    amount: number;
    orderRef: string;
    idempotencyKey: string;
  }): Promise<PaymentIntentResult> {
    const provider = this.providers[body.tender];
    // CASH / CARD_MANUAL settle at the counter; there is no rail to wait for.
    if (!provider) return { status: 'CAPTURED', providerRef: `manual_${body.idempotencyKey}` };
    return provider.createIntent({ ...body, tender: body.tender });
  }

  async status(tender: string, providerRef: string): Promise<PaymentIntentResult> {
    const provider = this.providers[tender];
    if (!provider) return { providerRef, status: 'CAPTURED' };
    return provider.getStatus(providerRef);
  }

  /**
   * PSP webhook sink. Public and unauthenticated, so the signature is the only
   * thing standing between a stranger and marking an order paid.
   *
   * Everything here refuses rather than explains. A caller who cannot produce a
   * valid signature learns only that it was rejected — telling them the
   * provider was unknown, or the reference missing, or the amount wrong, turns
   * the endpoint into a description of how to satisfy it.
   */
  async webhook(providerName: string, headers: Record<string, string>, rawBody: string) {
    const provider = Object.values(this.providers).find((p) => p.name === providerName);
    if (!provider) throw new UnauthorizedException(WEBHOOK_REFUSED);

    const { valid, event } = provider.verifyWebhook(headers, rawBody);
    if (!valid || !event?.eventId || !event.providerRef || !event.status) {
      throw new UnauthorizedException(WEBHOOK_REFUSED);
    }
    if (!ACCEPTED_STATUSES.has(event.status)) throw new UnauthorizedException(WEBHOOK_REFUSED);

    // Claim the delivery before acting on it. The unique index is what makes
    // this safe against a redelivery arriving while the first is still in
    // flight — two concurrent copies both pass a "have we seen this?" read.
    try {
      await this.prisma.webhookEvent.create({
        data: { provider: providerName, eventId: event.eventId, providerRef: event.providerRef },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Already applied. A PSP retries on any non-2xx, so this is ordinary
        // traffic and gets an ordinary answer — but the payment is not touched
        // a second time.
        return { ok: true, duplicate: true };
      }
      throw e;
    }

    const payment = await this.prisma.payment.findFirst({
      where: { providerRef: event.providerRef },
    });
    // Nothing to advance. Silent rather than 404: probing references until the
    // response changes would enumerate which ones exist.
    if (!payment) return { ok: true };

    // The PSP's figure has to match what the till recorded taking. Without
    // this, an event is free to declare any amount and the order still reads
    // as settled — the sale would show paid at a number nobody received.
    if (event.amount !== undefined && event.amount !== payment.amount) {
      await this.prisma.auditLog.create({
        data: {
          action: 'PAYMENT_AMOUNT_MISMATCH',
          entity: 'Payment',
          entityId: payment.id,
          detail: { expected: payment.amount, reported: event.amount, provider: providerName },
        },
      });
      return { ok: true };
    }

    // Terminal states do not move again. A late CAPTURED after a refund would
    // otherwise quietly restore the money on the books.
    if (TERMINAL_STATUSES.has(payment.status)) return { ok: true };

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: event.status },
    });
    return { ok: true };
  }

  /** Daily reconciliation summary: ledger tender totals for a date */
  async reconciliation(date: string) {
    const start = new Date(date);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const legs = await this.prisma.ledgerEntry.groupBy({
      by: ['account'],
      where: { createdAt: { gte: start, lt: end } },
      _sum: { debit: true, credit: true },
    });
    return legs.map((l) => ({
      account: l.account,
      debit: l._sum.debit ?? 0,
      credit: l._sum.credit ?? 0,
      net: (l._sum.debit ?? 0) - (l._sum.credit ?? 0),
    }));
  }
}
