import { PaymentProvider, PaymentIntentResult, WebhookVerification } from './provider.interface';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';

/**
 * Mock provider standing in for the local PSP aggregator (Fiuu / eGHL /
 * Revenue Monster). Emits an EMVCo-style dummy QR payload so the full
 * terminal UX (show QR → customer scans → webhook confirms) is testable
 * before merchant credentials arrive. Swap for the real adapter in v1.0.
 */
export class MockDuitNowProvider implements PaymentProvider {
  readonly name = 'MOCK_DUITNOW';
  private store = new Map<string, PaymentIntentResult>();

  async createIntent(params: {
    amount: number;
    orderRef: string;
    idempotencyKey: string;
    tender: string;
  }): Promise<PaymentIntentResult> {
    const existing = this.store.get(params.idempotencyKey);
    if (existing) return existing;
    const result: PaymentIntentResult = {
      providerRef: `mockdn_${randomUUID()}`,
      status: 'PENDING',
      qrPayload: `00020101021226580014A000000615000101065MOCK${params.orderRef}5303458540${(
        params.amount / 100
      ).toFixed(2)}5802MY6304TEST`,
    };
    this.store.set(params.idempotencyKey, result);
    // Simulate customer scanning + paying after 5s
    setTimeout(() => {
      result.status = 'CAPTURED';
    }, 5000);
    return result;
  }

  async getStatus(providerRef: string): Promise<PaymentIntentResult> {
    for (const r of this.store.values()) if (r.providerRef === providerRef) return r;
    return { providerRef, status: 'FAILED' };
  }

  async refund(providerRef: string, _amount: number) {
    return { ok: true, refundRef: `mockrf_${providerRef}` };
  }

  /**
   * Verify an HMAC over the bytes as they arrived.
   *
   * `rawBody` is the untouched request body, not a re-serialisation of the
   * parsed object. Re-stringifying JSON reorders keys, drops insignificant
   * whitespace and re-escapes unicode, so the digest is computed over a
   * different byte sequence than the one the PSP signed. Against the mock that
   * mismatch is invisible, because whatever produced the signature had gone
   * through the same mangling; against a real PSP it fails every single time,
   * and the fix people reach for under that pressure is to stop verifying.
   */
  verifyWebhook(headers: Record<string, string>, rawBody: string): WebhookVerification {
    const secret = process.env.PSP_WEBHOOK_SECRET;
    if (!secret) {
      // The previous default was `?? 'dev'`, so a deployment that forgot the
      // variable kept accepting webhooks — signed with a secret published in
      // this repository.
      throw new Error('PSP_WEBHOOK_SECRET is not set — refusing to verify webhook signatures');
    }

    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
    const presented = Buffer.from(headers['x-signature'] ?? '', 'hex');
    // Length-check first: timingSafeEqual throws on a mismatch rather than
    // returning false, and comparing lengths leaks nothing a response body
    // would not.
    const valid = presented.length === expected.length && timingSafeEqual(presented, expected);
    if (!valid) return { valid: false };

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawBody || '{}');
    } catch {
      return { valid: false };
    }
    return {
      valid: true,
      event: {
        // A stable id per delivery is what makes replay detectable. A PSP that
        // does not send one leaves the event unidentifiable, and it is refused
        // rather than applied blind.
        eventId: typeof event.eventId === 'string' ? event.eventId : undefined,
        providerRef: typeof event.providerRef === 'string' ? event.providerRef : undefined,
        status: typeof event.status === 'string' ? event.status : undefined,
        amount: typeof event.amount === 'number' ? event.amount : undefined,
      },
    };
  }
}
