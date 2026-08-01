import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { BillplzProvider, billplzFromEnv } from '../src/payments/providers/billplz.provider';
import { MANUAL_TENDERS, resolveProviders } from '../src/payments/providers/registry';

const SIGNATURE_KEY = 'billplz-signature-key';

const provider = () =>
  new BillplzProvider({
    apiKey: 'test-api-key',
    signatureKey: SIGNATURE_KEY,
    collectionId: 'coll-1',
    sandbox: true,
    callbackBaseUrl: 'https://api.example.test',
  });

/**
 * Billplz signs a reconstruction of the callback, not the bytes of it: fields
 * sorted, each rendered as key-immediately-followed-by-value, joined with
 * pipes. Every other gateway here signs the raw body. Getting this wrong fails
 * closed, which is safe but looks exactly like a broken integration, so it is
 * worth pinning precisely.
 */
function billplzSign(fields: Record<string, string>, key = SIGNATURE_KEY): string {
  const source = Object.entries(fields)
    .filter(([k]) => k !== 'x_signature')
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(([k, v]) => `${k}${v}`)
    .join('|');
  return createHmac('sha256', key).update(source, 'utf8').digest('hex');
}

function callback(fields: Record<string, string>, key = SIGNATURE_KEY): string {
  const body = new URLSearchParams(fields);
  body.set('x_signature', billplzSign(fields, key));
  return body.toString();
}

describe('Billplz — callback verification', () => {
  const paid = {
    id: 'bill_abc',
    collection_id: 'coll-1',
    paid: 'true',
    state: 'paid',
    amount: '4900',
    paid_amount: '4900',
    paid_at: '2026-08-01 10:15:00 +0800',
    email: 'pos@eiaawsolutions.com',
    name: 'Counter sale',
  };

  it('accepts a correctly signed callback and reads the payment off it', () => {
    const result = provider().verifyWebhook({}, callback(paid));

    expect(result.valid).toBe(true);
    expect(result.event).toMatchObject({
      providerRef: 'bill_abc',
      status: 'CAPTURED',
      amount: 4900,
    });
  });

  it('signs a reconstruction, so field order on the wire does not matter', () => {
    // The same fields sent in a different order must still verify — which is
    // only true because the scheme sorts before signing.
    const shuffled = new URLSearchParams();
    shuffled.set('paid_at', paid.paid_at);
    shuffled.set('id', paid.id);
    shuffled.set('paid', paid.paid);
    shuffled.set('state', paid.state);
    shuffled.set('amount', paid.amount);
    shuffled.set('paid_amount', paid.paid_amount);
    shuffled.set('collection_id', paid.collection_id);
    shuffled.set('email', paid.email);
    shuffled.set('name', paid.name);
    shuffled.set('x_signature', billplzSign(paid));

    expect(provider().verifyWebhook({}, shuffled.toString()).valid).toBe(true);
  });

  it('refuses a callback signed with another key', () => {
    expect(provider().verifyWebhook({}, callback(paid, 'wrong-key')).valid).toBe(false);
  });

  it('refuses a callback whose fields were edited after signing', () => {
    const tampered = callback(paid).replace('paid_amount=4900', 'paid_amount=1');
    expect(provider().verifyWebhook({}, tampered).valid).toBe(false);
  });

  it('refuses a callback carrying no signature at all', () => {
    expect(provider().verifyWebhook({}, new URLSearchParams(paid).toString()).valid).toBe(false);
  });

  it('refuses a signature that is not even the right length', () => {
    // timingSafeEqual throws on a length mismatch rather than returning false,
    // so this would be a 500 instead of a rejection if the length were not
    // checked first.
    const body = new URLSearchParams(paid);
    body.set('x_signature', 'ab');
    expect(provider().verifyWebhook({}, body.toString()).valid).toBe(false);
  });

  it('derives an event id that a retry repeats and a state change does not', () => {
    // Billplz sends no per-delivery id, and without one a replay cannot be told
    // from a retry — which is what the sink needs to refuse a captured payload
    // being sent back at it.
    const first = provider().verifyWebhook({}, callback(paid)).event?.eventId;
    const retried = provider().verifyWebhook({}, callback(paid)).event?.eventId;
    const later = provider().verifyWebhook({}, callback({ ...paid, state: 'deleted', paid: 'false' })).event
      ?.eventId;

    expect(first).toBe(retried);
    expect(later).not.toBe(first);
  });

  it('reports nothing to act on for a bill that is merely due', () => {
    const due = { id: 'bill_due', state: 'due', paid: 'false', amount: '4900', paid_amount: '0' };
    const result = provider().verifyWebhook({}, callback(due));

    expect(result.valid).toBe(true);
    // Valid but not actionable — the sink answers 200 and applies nothing,
    // rather than refusing and inviting an endless redelivery loop.
    expect(result.event?.status).toBeUndefined();
  });

  it('reports a deleted bill as failed', () => {
    const deleted = { id: 'bill_del', state: 'deleted', paid: 'false', amount: '4900', paid_amount: '0' };
    expect(provider().verifyWebhook({}, callback(deleted)).event?.status).toBe('FAILED');
  });
});

describe('Billplz — opening a bill', () => {
  /** Stand in for the gateway, and keep what it was asked for. */
  function stubFetch(response: { ok: boolean; status?: number; body?: unknown }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        json: async () => response.body,
        text: async () => JSON.stringify(response.body ?? {}),
      };
    }) as never;
    return { calls, restore: () => (globalThis.fetch = original) };
  }

  const created = { id: 'bill_new', url: 'https://www.billplz-sandbox.com/bills/bill_new', state: 'due' };

  it('returns the bill URL as the payload the terminal renders as a QR', async () => {
    const stub = stubFetch({ ok: true, body: created });
    try {
      const result = await provider().createIntent({
        amount: 4900,
        orderRef: '20260801-00001-t-hq',
        idempotencyKey: 'idem-1',
        tender: 'DUITNOW_QR',
      });
      expect(result).toMatchObject({
        providerRef: 'bill_new',
        status: 'PENDING',
        qrPayload: created.url,
      });
    } finally {
      stub.restore();
    }
  });

  it('posts a form to the sandbox host with basic auth and no customer contact', async () => {
    const stub = stubFetch({ ok: true, body: created });
    try {
      await provider().createIntent({
        amount: 4900,
        orderRef: 'ORDER-1',
        idempotencyKey: 'idem-2',
        tender: 'DUITNOW_QR',
      });

      const [call] = stub.calls;
      expect(call.url).toBe('https://www.billplz-sandbox.com/api/v3/bills');
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Basic ${Buffer.from('test-api-key:').toString('base64')}`);
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const sent = new URLSearchParams(String(call.init.body));
      expect(sent.get('collection_id')).toBe('coll-1');
      expect(sent.get('amount')).toBe('4900');
      // Carries our key so a bill can be traced back without trusting the
      // description, and never emails or texts a customer standing at the till.
      expect(sent.get('reference_1')).toBe('idem-2');
      expect(sent.get('deliver')).toBe('false');
      expect(sent.get('callback_url')).toBe('https://api.example.test/api/payments/webhook/BILLPLZ');
    } finally {
      stub.restore();
    }
  });

  it('goes to the live host when sandbox is off', async () => {
    const stub = stubFetch({ ok: true, body: created });
    try {
      const live = new BillplzProvider({
        apiKey: 'k',
        signatureKey: 's',
        collectionId: 'c',
        sandbox: false,
      });
      await live.createIntent({ amount: 100, orderRef: 'o', idempotencyKey: 'i', tender: 'DUITNOW_QR' });
      expect(stub.calls[0].url).toBe('https://www.billplz.com/api/v3/bills');
    } finally {
      stub.restore();
    }
  });

  it('throws rather than returning a bill that was never opened', async () => {
    const stub = stubFetch({ ok: false, status: 422, body: { error: 'nope' } });
    try {
      await expect(
        provider().createIntent({ amount: 100, orderRef: 'o', idempotencyKey: 'i', tender: 'DUITNOW_QR' }),
      ).rejects.toThrow(/422/);
    } finally {
      stub.restore();
    }
  });

  it('reads a paid bill back as captured', async () => {
    const stub = stubFetch({ ok: true, body: { id: 'bill_x', state: 'paid', paid: true } });
    try {
      expect(await provider().getStatus('bill_x')).toMatchObject({ status: 'CAPTURED' });
    } finally {
      stub.restore();
    }
  });

  it('reads a bill it cannot fetch as failed rather than pending forever', async () => {
    const stub = stubFetch({ ok: false, status: 404 });
    try {
      expect(await provider().getStatus('bill_gone')).toMatchObject({ status: 'FAILED' });
    } finally {
      stub.restore();
    }
  });
});

describe('Billplz — refunds', () => {
  it('says plainly that it cannot refund through the API', async () => {
    // Returning ok:true would put a refund on the books that never left the
    // merchant's account.
    await expect(provider().refund('bill_abc', 4900)).rejects.toThrow(/dashboard/i);
  });
});

describe('Billplz — configuration', () => {
  const complete = {
    BILLPLZ_API_KEY: 'k',
    BILLPLZ_X_SIGNATURE: 's',
    BILLPLZ_COLLECTION_ID: 'c',
  } as NodeJS.ProcessEnv;

  it('builds when every key is present', () => {
    expect(billplzFromEnv(complete)).toBeInstanceOf(BillplzProvider);
  });

  it('stays absent when any key is missing, rather than half-configured', () => {
    for (const missing of Object.keys(complete)) {
      const partial = { ...complete };
      delete partial[missing];
      expect(billplzFromEnv(partial)).toBeNull();
    }
    expect(billplzFromEnv({})).toBeNull();
  });

  it('accepts the signature key under either name the EIAAW secret set uses', () => {
    expect(
      billplzFromEnv({ BILLPLZ_API_KEY: 'k', BILLPLZ_SIGNATURE_KEY: 's', BILLPLZ_COLLECTION_ID: 'c' }),
    ).toBeInstanceOf(BillplzProvider);
  });
});

describe('provider routing', () => {
  it('routes the Malaysian rails to Billplz once it is configured', () => {
    const routing = resolveProviders({
      BILLPLZ_API_KEY: 'k',
      BILLPLZ_X_SIGNATURE: 's',
      BILLPLZ_COLLECTION_ID: 'c',
    });

    for (const tender of ['DUITNOW_QR', 'EWALLET_TNG', 'EWALLET_GRABPAY', 'EWALLET_BOOST']) {
      expect(routing.byTender[tender]?.name).toBe('BILLPLZ');
    }
  });

  it('routes nothing when no gateway is configured', () => {
    // Which is a supported way to run: cash and a manually-keyed card need no
    // account anywhere, and the terminal has to keep working before anyone has
    // signed up for anything.
    const routing = resolveProviders({});
    expect(routing.providers).toEqual([]);
    expect(routing.summary).toMatch(/no gateway/i);
  });

  it('leaves cash and manually-keyed cards to settle without a provider', () => {
    for (const tender of ['CASH', 'CARD_MANUAL', 'CARD_TERMINAL', 'STORE_CREDIT']) {
      expect(MANUAL_TENDERS.has(tender)).toBe(true);
    }
    expect(MANUAL_TENDERS.has('DUITNOW_QR')).toBe(false);
  });

  it('only registers the mock when something asks for it', () => {
    expect(resolveProviders({}).providers).toEqual([]);
    expect(resolveProviders({ PAYMENTS_ENABLE_MOCK: 'true' }).providers).toHaveLength(1);
  });

  it('refuses to start with the mock in production', () => {
    // It captures every payment five seconds after creation. In production that
    // is orders marked paid for money that never arrived, with books that
    // balance perfectly against a lie.
    expect(() => resolveProviders({ PAYMENTS_ENABLE_MOCK: 'true', NODE_ENV: 'production' })).toThrow(/mock/i);
  });

  it('prefers a real gateway over the mock when both are available', () => {
    const routing = resolveProviders({
      BILLPLZ_API_KEY: 'k',
      BILLPLZ_X_SIGNATURE: 's',
      BILLPLZ_COLLECTION_ID: 'c',
      PAYMENTS_ENABLE_MOCK: 'true',
    });
    expect(routing.byTender.DUITNOW_QR.name).toBe('BILLPLZ');
  });
});
