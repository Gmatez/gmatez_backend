import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config';
import { verifyHmacHeader } from '../../common/crypto/hashing';
import {
  PaymentIntentResult,
  PaymentProvider,
  PaymentWebhookEvent,
} from './payment-provider';

@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';

  constructor(private readonly config: AppConfigService) {}

  async createIntent(input: {
    amountCents: number;
    currency: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<PaymentIntentResult> {
    const key = this.config.get('STRIPE_SECRET_KEY');
    if (!key) {
      throw new Error('Stripe secret is not configured');
    }
    const providerPaymentId = `pi_${input.idempotencyKey}`;
    return {
      providerPaymentId,
      clientSecret: `stripe_secret_${providerPaymentId}`,
    };
  }

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    return verifyHmacHeader(
      this.config.get('PAYMENT_WEBHOOK_SECRET'),
      rawBody,
      signature,
    );
  }

  parseWebhook(rawBody: string): PaymentWebhookEvent {
    return JSON.parse(rawBody) as PaymentWebhookEvent;
  }
}
