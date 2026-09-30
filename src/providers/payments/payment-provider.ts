export type PaymentIntentResult = {
  providerPaymentId: string;
  clientSecret: string;
  checkoutUrl?: string;
};

export type PaymentWebhookEvent = {
  eventId: string;
  /** Provider order id used to find the internal Payment. */
  providerPaymentId: string;
  /** Captured provider payment id, when the event includes one. */
  providerCaptureId?: string;
  status:
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'refunded'
    | 'refund_failed'
    | 'ignored';
  amountCents: number;
  currency: string;
  refundId?: string;
  failureReason?: string;
};

export type ProviderPaymentSnapshot = {
  id: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  status: string;
  errorDescription?: string;
};

export type ProviderOrderSnapshot = {
  id: string;
  amountPaise: number;
  amountPaidPaise: number;
  currency: string;
  status: string;
};

export interface PaymentProvider {
  readonly name: string;
  createIntent(input: {
    amountCents: number;
    currency: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<PaymentIntentResult>;
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
  parseWebhook(rawBody: string, eventId?: string): PaymentWebhookEvent;
}
