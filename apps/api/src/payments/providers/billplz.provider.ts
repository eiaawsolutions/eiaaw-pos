import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentIntentResult, PaymentProvider, WebhookVerification } from './provider.interface';

/**
 * Billplz — the Malaysian rail set, and the one EIAAW already holds an account
 * for (see EIAAW-ORG `docs/runbooks/reuse-existing-subscriptions.md`; the same
 * keys are wired in the Social Media AI Team app). One contract covers DuitNow
 * QR, FPX, Touch 'n Go, GrabPay, Boost and ShopeePay, which is the whole set
 * the terminal offers.
 *
 * The flow is a hosted bill rather than a raw EMVCo payload: create a bill, get
 * back a URL, render that URL as the QR on the customer display. The customer
 * scans, picks their rail on Billplz's page, and the callback tells us it
 * settled. That is a bill page rather than a native DuitNow merchant QR — the
 * customer taps a method rather than pointing their banking app at a static
 * code — which is the trade for not holding a PayNet acquiring contract of our
 * own.
 */
export interface BillplzConfig {
  apiKey: string;
  signatureKey: string;
  collectionId: string;
  sandbox: boolean;
  /** Public base URL the PSP can reach, e.g. https://api.pos.example.com */
  callbackBaseUrl?: string;
}

const LIVE_BASE = 'https://www.billplz.com/api/v3';
const SANDBOX_BASE = 'https://www.billplz-sandbox.com/api/v3';

/** Billplz reports a bill's life as these; anything else is new and unhandled. */
const STATE_TO_STATUS: Record<string, PaymentIntentResult['status']> = {
  paid: 'CAPTURED',
  due: 'PENDING',
  deleted: 'FAILED',
};

export class BillplzProvider implements PaymentProvider {
  readonly name = 'BILLPLZ';

  constructor(private config: BillplzConfig) {}

  private get base() {
    return this.config.sandbox ? SANDBOX_BASE : LIVE_BASE;
  }

  /** Basic auth, API key as the username, empty password. */
  private get authHeader() {
    return `Basic ${Buffer.from(`${this.config.apiKey}:`).toString('base64')}`;
  }

  /**
   * Open a bill. Idempotency is the caller's — PaymentsService reserves the key
   * against a PaymentIntent row first — because Billplz has no idempotency key
   * of its own and would happily open a second bill for a retried request.
   */
  async createIntent(params: {
    amount: number;
    orderRef: string;
    idempotencyKey: string;
    tender: string;
  }): Promise<PaymentIntentResult> {
    const body = new URLSearchParams({
      collection_id: this.config.collectionId,
      // Billplz requires a contact. A walk-in customer at a till has given us
      // neither, and asking for an email to sell a teh tarik is not a thing, so
      // this is the merchant's own placeholder rather than anything personal.
      email: 'pos@eiaawsolutions.com',
      name: 'Counter sale',
      amount: String(params.amount),
      description: `Order ${params.orderRef}`.slice(0, 200),
      reference_1_label: 'Idempotency',
      reference_1: params.idempotencyKey,
      // Never true: a bill for a customer standing at the counter must not
      // email or text them.
      deliver: 'false',
      ...(this.config.callbackBaseUrl
        ? { callback_url: `${this.config.callbackBaseUrl}/api/payments/webhook/BILLPLZ` }
        : {}),
    });

    const res = await fetch(`${this.base}/bills`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`Billplz refused the bill (${res.status}): ${await res.text().catch(() => '')}`);
    }

    const bill = (await res.json()) as { id: string; url: string; state?: string };
    return {
      providerRef: bill.id,
      status: STATE_TO_STATUS[bill.state ?? 'due'] ?? 'PENDING',
      // The terminal renders this as the QR the customer scans.
      qrPayload: bill.url,
      redirectUrl: bill.url,
    };
  }

  async getStatus(providerRef: string): Promise<PaymentIntentResult> {
    const res = await fetch(`${this.base}/bills/${encodeURIComponent(providerRef)}`, {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) return { providerRef, status: 'FAILED' };

    const bill = (await res.json()) as { id: string; state?: string; paid?: boolean; url?: string };
    return {
      providerRef,
      status: bill.paid ? 'CAPTURED' : (STATE_TO_STATUS[bill.state ?? 'due'] ?? 'PENDING'),
      redirectUrl: bill.url,
    };
  }

  /**
   * Billplz has no refund API on v3 — refunds are raised by a human in the
   * dashboard. Saying so is better than returning `{ ok: true }` and letting
   * the books record a refund that never left the merchant's account.
   */
  async refund(providerRef: string, _amount: number): Promise<{ ok: boolean; refundRef?: string }> {
    throw new Error(
      `Billplz does not refund through the API — refund bill ${providerRef} in the Billplz dashboard, ` +
        'then void or refund the order here to keep the books in step',
    );
  }

  /**
   * Verify Billplz's X-Signature.
   *
   * Deliberately not an HMAC over the raw body, which is what every other
   * gateway here does and what the mock does. Billplz signs a *reconstruction*:
   * every callback field except `x_signature`, keys sorted ascending, each
   * rendered as `key` immediately followed by its value, the lot joined with
   * pipes. The signature then arrives as a field inside the body rather than as
   * a header, and the body is form-encoded rather than JSON.
   *
   * Parsing before verifying is safe here only because the scheme is defined
   * over the parsed fields — the signature covers exactly the values acted on
   * below. That reasoning does not transfer to a raw-body gateway, where
   * re-serialising is the bug this codebase already fixed once.
   */
  verifyWebhook(_headers: Record<string, string>, rawBody: string): WebhookVerification {
    const params = new URLSearchParams(rawBody);
    const presented = params.get('x_signature');
    if (!presented) return { valid: false };

    const pairs: [string, string][] = [];
    for (const [key, value] of params.entries()) {
      if (key === 'x_signature') continue;
      pairs.push([key, value]);
    }
    pairs.sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const source = pairs.map(([k, v]) => `${k}${v}`).join('|');

    const expected = createHmac('sha256', this.config.signatureKey).update(source, 'utf8').digest();
    const given = Buffer.from(presented, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { valid: false };

    const id = params.get('id') ?? undefined;
    const state = params.get('state') ?? undefined;
    const paid = params.get('paid') === 'true';
    const paidAmount = Number(params.get('paid_amount'));

    return {
      valid: true,
      event: {
        // Billplz sends no per-delivery id, so one is derived from what makes a
        // delivery distinct: the bill and the state it is reporting. A genuine
        // retry of the same event reduces to the same string and is dropped as
        // a replay; a later state change on the same bill does not.
        eventId: id ? `${id}:${state ?? 'unknown'}:${params.get('paid_at') ?? ''}` : undefined,
        providerRef: id,
        status: paid ? 'CAPTURED' : STATE_TO_STATUS[state ?? ''] === 'FAILED' ? 'FAILED' : undefined,
        amount: Number.isFinite(paidAmount) && paidAmount > 0 ? paidAmount : undefined,
      },
    };
  }
}

/**
 * Build the provider from environment, or return null when it is not
 * configured. Reads either spelling of each key: the EIAAW secret set already
 * in Infisical uses these names, and the house pattern is to teach the code the
 * existing names rather than rename secrets other projects depend on.
 */
export function billplzFromEnv(env: NodeJS.ProcessEnv = process.env): BillplzProvider | null {
  const apiKey = env.BILLPLZ_API_KEY;
  const signatureKey = env.BILLPLZ_X_SIGNATURE ?? env.BILLPLZ_SIGNATURE_KEY;
  const collectionId = env.BILLPLZ_COLLECTION_ID;
  if (!apiKey || !signatureKey || !collectionId) return null;

  return new BillplzProvider({
    apiKey,
    signatureKey,
    collectionId,
    sandbox: env.BILLPLZ_SANDBOX === 'true',
    callbackBaseUrl: env.PUBLIC_API_URL,
  });
}
