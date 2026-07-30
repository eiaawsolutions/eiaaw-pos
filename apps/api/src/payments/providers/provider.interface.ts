/**
 * Payments Abstraction Layer (PAL).
 * Every rail (DuitNow QR via Fiuu/eGHL/Revenue Monster, Stripe, Adyen, cash)
 * implements this interface. The POS core never talks to a PSP directly and
 * never sees a PAN — card-present flows stay on the acquirer's terminal
 * (PCI SAQ-A posture).
 */
export interface PaymentIntentResult {
  providerRef: string;
  status: 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED';
  /** For QR rails: the payload to render as a dynamic QR at the terminal/customer display */
  qrPayload?: string;
  redirectUrl?: string;
}

export interface PaymentProvider {
  readonly name: string;
  /** Create a charge/intent for `amount` sen. Must be idempotent on idempotencyKey. */
  createIntent(params: {
    amount: number;
    orderRef: string;
    idempotencyKey: string;
    tender: string;
  }): Promise<PaymentIntentResult>;
  /** Poll or resolve final status */
  getStatus(providerRef: string): Promise<PaymentIntentResult>;
  /** Rail-native refund where supported */
  refund(providerRef: string, amount: number): Promise<{ ok: boolean; refundRef?: string }>;
  /** Verify webhook signature and normalize the event */
  verifyWebhook(headers: Record<string, string>, rawBody: string): { valid: boolean; event?: any };
}
