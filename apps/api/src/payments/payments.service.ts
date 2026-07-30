import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentProvider } from './providers/provider.interface';
import { MockDuitNowProvider } from './providers/mock.provider';

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

  /** Start a non-cash payment: returns QR payload / redirect for the terminal */
  async createIntent(body: { tender: string; amount: number; orderRef: string; idempotencyKey: string }) {
    const provider = this.providers[body.tender];
    if (!provider) return { status: 'CAPTURED', providerRef: `manual_${body.idempotencyKey}` }; // CASH / CARD_MANUAL
    return provider.createIntent({ ...body, tender: body.tender });
  }

  async status(tender: string, providerRef: string) {
    const provider = this.providers[tender];
    if (!provider) return { providerRef, status: 'CAPTURED' };
    return provider.getStatus(providerRef);
  }

  /** PSP webhook sink — signature-verified, then payment status advanced */
  async webhook(providerName: string, headers: Record<string, string>, rawBody: string) {
    const provider = Object.values(this.providers).find((p) => p.name === providerName);
    if (!provider) return { ok: false, reason: 'unknown provider' };
    const { valid, event } = provider.verifyWebhook(headers, rawBody);
    if (!valid) return { ok: false, reason: 'bad signature' };
    if (event?.providerRef && event?.status) {
      await this.prisma.payment.updateMany({
        where: { providerRef: event.providerRef },
        data: { status: event.status },
      });
    }
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
