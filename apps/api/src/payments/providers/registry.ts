import { Logger } from '@nestjs/common';
import { PaymentProvider } from './provider.interface';
import { MockDuitNowProvider } from './mock.provider';
import { billplzFromEnv } from './billplz.provider';

/**
 * Tenders that settle at the counter with no gateway involved: the cash is in
 * the drawer, or the card was run on the bank's own terminal and the cashier
 * typed the approval code. These need no provider and never did.
 */
export const MANUAL_TENDERS = new Set(['CASH', 'CARD_MANUAL', 'CARD_TERMINAL', 'STORE_CREDIT']);

/** Tenders a Malaysian gateway settles. */
const GATEWAY_TENDERS = ['DUITNOW_QR', 'EWALLET_TNG', 'EWALLET_GRABPAY', 'EWALLET_BOOST'];

export interface ProviderRouting {
  /** Tender → the provider that settles it. Absent means nobody does. */
  byTender: Record<string, PaymentProvider>;
  /** Every distinct provider, for webhook lookup by name. */
  providers: PaymentProvider[];
  /** What was chosen and why, logged once at boot so a misconfiguration is visible. */
  summary: string;
}

/**
 * Decide which gateway settles which tender, from configuration alone.
 *
 * The POS is meant to run before any gateway exists: a merchant selling for
 * cash and running cards on the bank's EDC needs no account anywhere, and that
 * has to keep working. Adding credentials later is the only step required to
 * light the electronic rails up — no code change, no redeploy of anything but
 * the environment.
 *
 * The mock is the dangerous part of that promise. It captures every payment
 * five seconds after it is created, so a production instance that fell back to
 * it would mark orders paid for money that never arrived, and the books would
 * balance perfectly against a lie. It is therefore only ever registered when
 * something explicitly asks for it, and never when NODE_ENV is production.
 */
export function resolveProviders(env: NodeJS.ProcessEnv = process.env): ProviderRouting {
  const byTender: Record<string, PaymentProvider> = {};
  const providers: PaymentProvider[] = [];
  const notes: string[] = [];

  const billplz = billplzFromEnv(env);
  if (billplz) {
    providers.push(billplz);
    for (const tender of GATEWAY_TENDERS) byTender[tender] = billplz;
    notes.push(
      `Billplz${env.BILLPLZ_SANDBOX === 'true' ? ' (sandbox)' : ''} → ${GATEWAY_TENDERS.join(', ')}`,
    );
  }

  const isProduction = env.NODE_ENV === 'production';
  const mockRequested = env.PAYMENTS_ENABLE_MOCK === 'true';
  if (mockRequested && isProduction) {
    throw new Error(
      'PAYMENTS_ENABLE_MOCK is set in production. The mock captures every payment after five seconds, ' +
        'so this would record money that was never received. Configure a real gateway instead.',
    );
  }
  if (mockRequested) {
    const mock = new MockDuitNowProvider();
    providers.push(mock);
    for (const tender of GATEWAY_TENDERS) byTender[tender] ??= mock;
    notes.push(`mock → ${GATEWAY_TENDERS.filter((t) => byTender[t] === mock).join(', ') || 'nothing'}`);
  }

  if (!notes.length) {
    notes.push('no gateway configured — cash and manually-keyed card only');
  }

  return { byTender, providers, summary: notes.join('; ') };
}

/**
 * What to tell someone whose terminal just refused an electronic tender. Names
 * the variables rather than the failure, because the person reading it is
 * trying to turn the rail on, not debug our routing.
 */
export function unconfiguredTenderMessage(tender: string): string {
  return (
    `${tender} has no payment gateway configured. Set BILLPLZ_API_KEY, BILLPLZ_X_SIGNATURE and ` +
    'BILLPLZ_COLLECTION_ID to enable it, or take the sale as cash or a manually-keyed card.'
  );
}

export function logRouting(routing: ProviderRouting, logger = new Logger('Payments')) {
  logger.log(`Payment routing: ${routing.summary}`);
}
