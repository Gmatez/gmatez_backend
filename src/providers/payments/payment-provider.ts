export type PaymentIntentResult = {
  providerPaymentId: string;
  clientSecret: string;
  checkoutUrl?: string;
};

export type PaymentWebhookEvent = {
  eventId: string;
  providerPaymentId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  amountCents: number;
  currency: string;
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
  parseWebhook(rawBody: string): PaymentWebhookEvent;
}
