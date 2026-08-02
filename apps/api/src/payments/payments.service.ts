import {
  BadRequestException,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentIntentResult, PaymentProvider } from './providers/provider.interface';
import {
  MANUAL_TENDERS,
  ProviderRouting,
  logRouting,
  resolveProviders,
  unconfiguredTenderMessage,
} from './providers/registry';

/** One answer for every way a webhook can be rejected. */
const WEBHOOK_REFUSED = 'Webhook rejected';

/** Statuses a PSP may move a payment into. Anything else is not ours to apply. */
const ACCEPTED_STATUSES = new Set(['AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED']);

/** Once here, a payment does not move again on a PSP's say-so. */
const TERMINAL_STATUSES = new Set(['REFUNDED', 'CANCELLED']);

@Injectable()
export class PaymentsService implements OnModuleInit {
  private routing: ProviderRouting;

  constructor(private prisma: PrismaService) {
    this.routing = resolveProviders();
  }

  onModuleInit() {
    // Logged once at boot: which rails are live is the first thing anyone
    // debugging a refused tender needs, and the first thing to check after
    // adding credentials.
    logRouting(this.routing);
  }

  /** Re-read configuration. Only for tests, which vary the environment per case. */
  reloadProviders(env: NodeJS.ProcessEnv = process.env) {
    this.routing = resolveProviders(env);
  }

  private providerFor(tender: string): PaymentProvider | undefined {
    return this.routing.byTender[tender];
  }

  /**
   * Start a payment and hand the terminal whatever the customer needs to see.
   *
   * Idempotent on idempotencyKey, durably. The key is reserved against a row
   * before the gateway is called, so a double-tapped Charge button — or a retry
   * landing on another replica — returns the first bill rather than opening a
   * second one for the customer to pay twice.
   */
  async createIntent(body: {
    tender: string;
    amount: number;
    orderRef: string;
    idempotencyKey: string;
  }): Promise<PaymentIntentResult> {
    if (!Number.isInteger(body?.amount) || body.amount <= 0) {
      throw new BadRequestException(`Invalid payment amount ${body?.amount}`);
    }
    if (!body.idempotencyKey) throw new BadRequestException('An idempotency key is required');

    // Cash and manually-keyed cards settle at the counter; there is no rail to
    // wait for and nothing to reserve.
    if (MANUAL_TENDERS.has(body.tender)) {
      return { status: 'CAPTURED', providerRef: `manual_${body.idempotencyKey}` };
    }

    const provider = this.providerFor(body.tender);
    // Refusing beats mocking. A terminal that says "not configured" sends the
    // cashier to another tender; one that silently captures sends the customer
    // away with goods and no money taken.
    if (!provider) throw new BadRequestException(unconfiguredTenderMessage(body.tender));

    const existing = await this.prisma.paymentIntent.findUnique({
      where: { idempotencyKey: body.idempotencyKey },
    });
    if (existing?.providerRef) {
      return {
        providerRef: existing.providerRef,
        status: existing.status as PaymentIntentResult['status'],
        qrPayload: existing.redirectUrl ?? undefined,
        redirectUrl: existing.redirectUrl ?? undefined,
      };
    }

    // Claim the key before calling out. If two requests race, one loses the
    // unique index and re-reads the winner's bill rather than opening its own.
    if (!existing) {
      try {
        await this.prisma.paymentIntent.create({
          data: {
            idempotencyKey: body.idempotencyKey,
            provider: provider.name,
            tender: body.tender,
            amount: body.amount,
            orderRef: body.orderRef,
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const winner = await this.prisma.paymentIntent.findUnique({
            where: { idempotencyKey: body.idempotencyKey },
          });
          if (winner?.providerRef) {
            return {
              providerRef: winner.providerRef,
              status: winner.status as PaymentIntentResult['status'],
              qrPayload: winner.redirectUrl ?? undefined,
              redirectUrl: winner.redirectUrl ?? undefined,
            };
          }
        } else throw e;
      }
    }

    let result: PaymentIntentResult;
    try {
      result = await provider.createIntent({ ...body, tender: body.tender });
    } catch (e) {
      // The reservation row stays, with no provider reference on it. That is
      // deliberate: the next attempt with the same key finds it unfulfilled and
      // calls the gateway again, so a transient outage is retryable without
      // risking a second bill.
      throw new ServiceUnavailableException(
        `${provider.name} could not start this ${body.tender} payment — take the sale as cash or a ` +
          `manually-keyed card, or try again. (${e instanceof Error ? e.message : 'unknown error'})`,
      );
    }

    await this.prisma.paymentIntent.update({
      where: { idempotencyKey: body.idempotencyKey },
      data: {
        providerRef: result.providerRef,
        status: result.status,
        redirectUrl: result.redirectUrl ?? result.qrPayload ?? null,
      },
    });
    return result;
  }

  async status(tender: string, providerRef: string): Promise<PaymentIntentResult> {
    const provider = this.providerFor(tender);
    if (!provider) return { providerRef, status: 'CAPTURED' };
    return provider.getStatus(providerRef);
  }

  /**
   * PSP webhook sink. Public and unauthenticated, so the signature is the only
   * thing standing between a stranger and marking an order paid.
   *
   * Rejection is silent and uniform: a caller who cannot produce a valid
   * signature learns only that it was rejected. Telling them the provider was
   * unknown, or the reference missing, turns the endpoint into a description of
   * how to satisfy it.
   *
   * A *valid* delivery we simply have nothing to do with is a different case
   * and answers 200. Every PSP retries on a non-2xx, so refusing the routine
   * "still due" callbacks Billplz sends would buy an endless redelivery loop
   * for no benefit.
   */
  async webhook(providerName: string, headers: Record<string, string>, rawBody: string) {
    const provider = this.routing.providers.find((p) => p.name === providerName);
    if (!provider) throw new UnauthorizedException(WEBHOOK_REFUSED);

    const { valid, event } = provider.verifyWebhook(headers, rawBody);
    // No event id means a replay cannot be told from a retry, which makes the
    // delivery unsafe to apply at all.
    if (!valid || !event?.eventId || !event.providerRef) {
      throw new UnauthorizedException(WEBHOOK_REFUSED);
    }

    try {
      await this.prisma.webhookEvent.create({
        data: { provider: providerName, eventId: event.eventId, providerRef: event.providerRef },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { ok: true, duplicate: true };
      }
      throw e;
    }

    // Signed, and about a bill we know, but reporting nothing we act on — a
    // "due" callback, or a state this version does not handle. Recorded so a
    // new state a gateway starts sending is visible rather than invisible.
    if (!event.status || !ACCEPTED_STATUSES.has(event.status)) {
      await this.prisma.auditLog.create({
        data: {
          action: 'PAYMENT_WEBHOOK_UNHANDLED',
          entity: 'Payment',
          detail: { provider: providerName, providerRef: event.providerRef, status: event.status ?? null },
        },
      });
      return { ok: true };
    }

    // Keep the intent in step even before the order lands: the terminal may
    // still be polling, and the customer has paid.
    await this.prisma.paymentIntent.updateMany({
      where: { providerRef: event.providerRef },
      data: { status: event.status },
    });

    const payment = await this.prisma.payment.findFirst({ where: { providerRef: event.providerRef } });
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

    await this.prisma.payment.update({ where: { id: payment.id }, data: { status: event.status } });
    return { ok: true };
  }

  /**
   * Daily reconciliation summary: ledger tender totals for a date.
   *
   * `outletId` is undefined only for a caller who is not pinned to one — an
   * owner reading the whole business. Anyone pinned gets their own outlet and
   * nothing else; the column and its composite index have been on LedgerEntry
   * since ledger legs started carrying where the money moved.
   */
  async reconciliation(date: string, outletId?: string) {
    const start = new Date(date);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const legs = await this.prisma.ledgerEntry.groupBy({
      by: ['account'],
      where: { createdAt: { gte: start, lt: end }, ...(outletId ? { outletId } : {}) },
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
