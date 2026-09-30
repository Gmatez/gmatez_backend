import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config';
import {
  hmacSha256,
  sha256,
  verifyHmacHeader,
} from '../../common/crypto/hashing';
import {
  PaymentIntentResult,
  PaymentProvider,
  PaymentWebhookEvent,
  ProviderOrderSnapshot,
  ProviderPaymentSnapshot,
} from './payment-provider';

const RAZORPAY_API = 'https://api.razorpay.com/v1';

type RazorpayPaymentEntity = {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  order_id?: string | null;
  error_description?: string | null;
};

type RazorpayOrderEntity = {
  id?: string;
  amount?: number;
  amount_paid?: number;
  currency?: string;
  status?: string;
};

type RazorpayRefundEntity = {
  id?: string;
  amount?: number;
  currency?: string;
  payment_id?: string;
  status?: string;
};

type RazorpayEventBody = {
  event?: string;
  payload?: {
    payment?: { entity?: RazorpayPaymentEntity };
    order?: { entity?: RazorpayOrderEntity };
    refund?: { entity?: RazorpayRefundEntity };
  };
};

/**
 * Razorpay Orders + Payments + Refunds.
 * Key secret and webhook secret stay in this process. The public Key ID is
 * returned to Flutter only as checkout.keyId.
 */
@Injectable()
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = 'razorpay';
  private readonly logger = new Logger(RazorpayPaymentProvider.name);
  /** Overridden in unit tests. Nest injects only AppConfigService. */
  fetchImpl: typeof fetch = fetch;

  constructor(private readonly config: AppConfigService) {}

  async createIntent(input: {
    amountCents: number;
    currency: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<PaymentIntentResult> {
    if (!Number.isInteger(input.amountCents) || input.amountCents < 100) {
      throw new Error(
        'Razorpay order amount must be an integer of at least 100 paise',
      );
    }
    if (input.currency.toUpperCase() !== 'INR') {
      throw new Error('Razorpay orders are created in INR only');
    }
    const order = await this.request<RazorpayOrderEntity>('POST', '/orders', {
      amount: input.amountCents,
      currency: 'INR',
      receipt: input.idempotencyKey.slice(0, 40),
      notes: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (!order.id || order.amount !== input.amountCents) {
      throw new Error(
        'Razorpay order response did not match the requested amount',
      );
    }
    this.logger.log({
      event: 'razorpay_order_created',
      orderId: order.id,
      amountPaise: order.amount,
      currency: 'INR',
      userId: input.userId,
    });
    return {
      providerPaymentId: order.id,
      clientSecret: '',
    };
  }

  /**
   * Razorpay webhook HMAC of the exact raw body using RAZORPAY_WEBHOOK_SECRET.
   * This is not the generic PAYMENT_WEBHOOK_SECRET used by the mock provider.
   */
  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    const secret = this.config.get('RAZORPAY_WEBHOOK_SECRET');
    if (!secret) {
      return false;
    }
    return verifyHmacHeader(secret, rawBody, signature);
  }

  /**
   * Checkout signature: HMAC_SHA256(`${orderId}|${paymentId}`, key_secret).
   */
  verifyCheckoutSignature(input: {
    orderId: string;
    paymentId: string;
    signature: string;
  }): boolean {
    const secret = this.config.get('RAZORPAY_KEY_SECRET');
    if (!secret || !input.signature || !input.orderId || !input.paymentId) {
      return false;
    }
    return verifyHmacHeader(
      secret,
      `${input.orderId}|${input.paymentId}`,
      input.signature,
    );
  }

  parseWebhook(rawBody: string, eventId?: string): PaymentWebhookEvent {
    const body = JSON.parse(rawBody) as RazorpayEventBody;
    const id = eventId?.trim() || sha256(rawBody);
    const payment = body.payload?.payment?.entity;
    const order = body.payload?.order?.entity;
    const refund = body.payload?.refund?.entity;
    const event = body.event ?? '';

    if (event === 'payment.captured' && payment?.id && payment.order_id) {
      return {
        eventId: id,
        providerPaymentId: payment.order_id,
        providerCaptureId: payment.id,
        status: payment.status === 'captured' ? 'succeeded' : 'ignored',
        amountCents: payment.amount ?? 0,
        currency: payment.currency ?? '',
      };
    }

    if (event === 'order.paid' && order?.id) {
      const captured =
        payment?.status === 'captured' && payment.order_id === order.id
          ? payment
          : undefined;
      return {
        eventId: id,
        providerPaymentId: order.id,
        providerCaptureId: captured?.id,
        status: captured ? 'succeeded' : 'ignored',
        amountCents: captured?.amount ?? order.amount_paid ?? order.amount ?? 0,
        currency: captured?.currency ?? order.currency ?? '',
      };
    }

    if (event === 'payment.failed' && payment?.order_id) {
      return {
        eventId: id,
        providerPaymentId: payment.order_id,
        providerCaptureId: payment.id,
        status: 'failed',
        amountCents: payment.amount ?? 0,
        currency: payment.currency ?? '',
        failureReason: sanitizeFailure(payment.error_description),
      };
    }

    if (
      (event === 'refund.processed' || event === 'refund.created') &&
      refund?.id
    ) {
      return {
        eventId: id,
        providerPaymentId: payment?.order_id ?? '',
        providerCaptureId: refund.payment_id ?? payment?.id,
        status:
          refund.status === 'processed' || event === 'refund.processed'
            ? 'refunded'
            : 'ignored',
        amountCents: refund.amount ?? 0,
        currency: refund.currency ?? payment?.currency ?? '',
        refundId: refund.id,
      };
    }

    if (event === 'refund.failed' && refund?.id) {
      return {
        eventId: id,
        providerPaymentId: payment?.order_id ?? '',
        providerCaptureId: refund.payment_id ?? payment?.id,
        status: 'refund_failed',
        amountCents: refund.amount ?? 0,
        currency: refund.currency ?? '',
        refundId: refund.id,
      };
    }

    return {
      eventId: id,
      providerPaymentId: payment?.order_id ?? order?.id ?? '',
      status: 'ignored',
      amountCents: 0,
      currency: '',
    };
  }

  async fetchPayment(paymentId: string): Promise<ProviderPaymentSnapshot> {
    const entity = await this.request<RazorpayPaymentEntity>(
      'GET',
      `/payments/${encodeURIComponent(paymentId)}`,
    );
    if (
      !entity.id ||
      !entity.order_id ||
      entity.amount == null ||
      !entity.currency
    ) {
      throw new Error('Razorpay payment response was incomplete');
    }
    return {
      id: entity.id,
      orderId: entity.order_id,
      amountPaise: entity.amount,
      currency: entity.currency,
      status: entity.status ?? '',
      errorDescription: sanitizeFailure(entity.error_description),
    };
  }

  async fetchOrder(orderId: string): Promise<ProviderOrderSnapshot> {
    const entity = await this.request<RazorpayOrderEntity>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}`,
    );
    if (!entity.id || entity.amount == null || !entity.currency) {
      throw new Error('Razorpay order response was incomplete');
    }
    return {
      id: entity.id,
      amountPaise: entity.amount,
      amountPaidPaise: entity.amount_paid ?? 0,
      currency: entity.currency,
      status: entity.status ?? '',
    };
  }

  async fetchOrderPayments(
    orderId: string,
  ): Promise<ProviderPaymentSnapshot[]> {
    const body = await this.request<{ items?: RazorpayPaymentEntity[] }>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}/payments`,
    );
    return (body.items ?? [])
      .filter((item) => item.id && item.order_id && item.amount != null)
      .map((item) => ({
        id: item.id as string,
        orderId: item.order_id as string,
        amountPaise: item.amount as number,
        currency: item.currency ?? '',
        status: item.status ?? '',
        errorDescription: sanitizeFailure(item.error_description),
      }));
  }

  async createRefund(input: {
    paymentId: string;
    amountPaise: number;
    receipt: string;
  }): Promise<{ id: string; status: string; amountPaise: number }> {
    const refund = await this.request<RazorpayRefundEntity>(
      'POST',
      `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      {
        amount: input.amountPaise,
        receipt: input.receipt.slice(0, 40),
        notes: { receipt: input.receipt.slice(0, 40) },
      },
    );
    if (!refund.id || refund.amount == null) {
      throw new Error('Razorpay refund response was incomplete');
    }
    return {
      id: refund.id,
      status: refund.status ?? 'pending',
      amountPaise: refund.amount,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const keyId = this.config.get('RAZORPAY_KEY_ID');
    const keySecret = this.config.get('RAZORPAY_KEY_SECRET');
    if (!keyId || !keySecret) {
      throw new Error(
        'Razorpay credentials are not configured. CONFIG_REQUIRED.',
      );
    }
    const response = await this.fetchImpl(`${RAZORPAY_API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      let code = `http_${response.status}`;
      try {
        const parsed = JSON.parse(text) as {
          error?: { code?: string; description?: string };
        };
        code = parsed.error?.code ?? code;
      } catch {
        code = `http_${response.status}`;
      }
      this.logger.warn(
        { event: 'razorpay_http_error', status: response.status, code, path },
        'razorpay.request_failed',
      );
      throw new Error(`Razorpay request failed: ${code}`);
    }
    return JSON.parse(text) as T;
  }
}

function sanitizeFailure(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\d{12,}/g, '****').slice(0, 180);
}

export function checkoutMac(
  secret: string,
  orderId: string,
  paymentId: string,
) {
  return hmacSha256(secret, `${orderId}|${paymentId}`);
}
