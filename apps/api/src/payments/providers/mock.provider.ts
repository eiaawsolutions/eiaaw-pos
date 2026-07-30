import { PaymentProvider, PaymentIntentResult } from './provider.interface';
import { randomUUID, createHmac } from 'crypto';

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

  verifyWebhook(headers: Record<string, string>, rawBody: string) {
    const secret = process.env.PSP_WEBHOOK_SECRET ?? 'dev';
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return { valid: headers['x-signature'] === expected, event: JSON.parse(rawBody || '{}') };
  }
}
