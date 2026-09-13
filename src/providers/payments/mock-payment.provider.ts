import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hmacSha256, verifyHmacHeader } from '../../common/crypto/hashing';
import { AppConfigService } from '../../config/app-config';
import {
  PaymentIntentResult,
  PaymentProvider,
  PaymentWebhookEvent,
} from './payment-provider';

@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  constructor(private readonly config: AppConfigService) {}

  async createIntent(input: {
    amountCents: number;
    currency: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<PaymentIntentResult> {
    const providerPaymentId = `pay_${input.idempotencyKey}`;
    return {
      providerPaymentId,
      clientSecret: `secret_${providerPaymentId}`,
      checkoutUrl: `https://payments.local/checkout/${providerPaymentId}`,
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
    const parsed = JSON.parse(rawBody) as PaymentWebhookEvent;
    return {
      eventId: parsed.eventId ?? randomUUID(),
      providerPaymentId: parsed.providerPaymentId,
      status: parsed.status,
      amountCents: parsed.amountCents,
      currency: parsed.currency,
    };
  }

  sign(body: string): string {
    return hmacSha256(this.config.get('PAYMENT_WEBHOOK_SECRET'), body);
  }
}
