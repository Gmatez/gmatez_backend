import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config';
import { verifyHmacHeader } from '../../common/crypto/hashing';
import {
  PaymentIntentResult,
  PaymentProvider,
  PaymentWebhookEvent,
} from './payment-provider';

/**
 * Stripe PaymentIntent provider.
 * CONFIG_REQUIRED: STRIPE_SECRET_KEY for live intents.
 * Webhook HMAC still uses PAYMENT_WEBHOOK_SECRET for the generic callback contract.
 */
@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly logger = new Logger(StripePaymentProvider.name);

  constructor(private readonly config: AppConfigService) {}

  async createIntent(input: {
    amountCents: number;
    currency: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<PaymentIntentResult> {
    const key = this.config.get('STRIPE_SECRET_KEY');
    if (!key) {
      throw new Error(
        'STRIPE_SECRET_KEY is not configured. CONFIG_REQUIRED for real Stripe.',
      );
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Stripe = require('stripe') as new (apiKey: string) => {
        paymentIntents: {
          create: (
            params: Record<string, unknown>,
            opts: { idempotencyKey: string },
          ) => Promise<{ id: string; client_secret: string | null }>;
        };
      };
      const stripe = new Stripe(key);
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: input.currency.toLowerCase(),
          metadata: {
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
          },
          automatic_payment_methods: { enabled: true },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (!intent.client_secret) {
        throw new Error('Stripe PaymentIntent missing client_secret');
      }
      return {
        providerPaymentId: intent.id,
        clientSecret: intent.client_secret,
      };
    } catch (error) {
      this.logger.error(
        {
          err: error instanceof Error ? error.message : 'unknown',
        },
        'stripe.create_intent_failed',
      );
      throw error;
    }
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
