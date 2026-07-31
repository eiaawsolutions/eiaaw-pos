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

/** A verified webhook, normalised to the fields the sink is allowed to act on. */
export interface WebhookVerification {
  valid: boolean;
  event?: {
    /** Stable per delivery. Without it a replay cannot be told from a retry. */
    eventId?: string;
    providerRef?: string;
    status?: string;
    /** Sen, as the PSP reports it — checked against what we recorded taking. */
    amount?: number;
  };
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
  /**
   * Verify the signature over the body **as it arrived on the wire** and
   * normalise the event. Never pass a re-serialised object: the digest would
   * be taken over different bytes than the PSP signed.
   */
  verifyWebhook(headers: Record<string, string>, rawBody: string): WebhookVerification;
}
