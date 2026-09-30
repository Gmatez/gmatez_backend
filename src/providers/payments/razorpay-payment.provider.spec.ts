import { hmacSha256 } from '../../common/crypto/hashing';
import { AppConfigService } from '../../config/app-config';
import {
  RazorpayPaymentProvider,
  checkoutMac,
} from './razorpay-payment.provider';

const KEY_ID = 'rzp_test_public';
const KEY_SECRET = 'razorpay-key-secret-test';
const WEBHOOK_SECRET = 'razorpay-webhook-secret-test';

function config(): AppConfigService {
  const values: Record<string, string> = {
    RAZORPAY_KEY_ID: KEY_ID,
    RAZORPAY_KEY_SECRET: KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  };
  return {
    get: (key: string) => values[key] ?? '',
  } as AppConfigService;
}

function capturedBody() {
  return JSON.stringify({
    entity: 'event',
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_test_1',
          entity: 'payment',
          amount: 50000,
          currency: 'INR',
          status: 'captured',
          order_id: 'order_test_1',
          method: 'upi',
        },
      },
    },
  });
}

describe('RazorpayPaymentProvider signatures', () => {
  const provider = new RazorpayPaymentProvider(config());

  it('verifies a Razorpay webhook signature and rejects the generic secret', () => {
    const body = capturedBody();
    const signature = hmacSha256(WEBHOOK_SECRET, body);
    expect(provider.verifyWebhook(body, signature)).toBe(true);
    expect(provider.verifyWebhook(body, hmacSha256('other-secret', body))).toBe(
      false,
    );
    expect(provider.verifyWebhook(body, undefined)).toBe(false);
  });

  it('verifies checkout HMAC of order_id|payment_id with the key secret', () => {
    const signature = checkoutMac(KEY_SECRET, 'order_test_1', 'pay_test_1');
    expect(
      provider.verifyCheckoutSignature({
        orderId: 'order_test_1',
        paymentId: 'pay_test_1',
        signature,
      }),
    ).toBe(true);
    expect(
      provider.verifyCheckoutSignature({
        orderId: 'order_test_1',
        paymentId: 'pay_test_1',
        signature: hmacSha256(WEBHOOK_SECRET, 'order_test_1|pay_test_1'),
      }),
    ).toBe(false);
    expect(
      provider.verifyCheckoutSignature({
        orderId: 'order_other',
        paymentId: 'pay_test_1',
        signature,
      }),
    ).toBe(false);
  });

  it('parses payment.captured into a succeeded capture', () => {
    const body = capturedBody();
    const event = provider.parseWebhook(body, 'evt_1');
    expect(event).toMatchObject({
      eventId: 'evt_1',
      providerPaymentId: 'order_test_1',
      providerCaptureId: 'pay_test_1',
      status: 'succeeded',
      amountCents: 50000,
      currency: 'INR',
    });
  });

  it('parses payment.failed without treating it as a capture', () => {
    const body = JSON.stringify({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay_fail',
            amount: 50000,
            currency: 'INR',
            status: 'failed',
            order_id: 'order_test_1',
            error_description: 'Payment failed',
          },
        },
      },
    });
    const event = provider.parseWebhook(body, 'evt_fail');
    expect(event.status).toBe('failed');
    expect(event.providerPaymentId).toBe('order_test_1');
  });

  it('ignores refund.created until the refund is processed', () => {
    const body = JSON.stringify({
      event: 'refund.created',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_1',
            amount: 50000,
            currency: 'INR',
            payment_id: 'pay_test_1',
            status: 'pending',
          },
        },
      },
    });
    expect(provider.parseWebhook(body, 'evt_rf').status).toBe('ignored');
  });
});

describe('RazorpayPaymentProvider orders', () => {
  it('creates an INR order for the server amount and does not return the secret', async () => {
    const provider = new RazorpayPaymentProvider(config());
    provider.fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          id: 'order_test_1',
          amount: 50000,
          currency: 'INR',
          status: 'created',
        }),
    });
    const intent = await provider.createIntent({
      amountCents: 50000,
      currency: 'INR',
      userId: 'user-1',
      idempotencyKey: 'idem-key-1234',
    });
    expect(intent.providerPaymentId).toBe('order_test_1');
    expect(intent.clientSecret).toBe('');
    const [url, init] = (provider.fetchImpl as jest.Mock).mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://api.razorpay.com/v1/orders');
    expect(init.headers.Authorization?.startsWith('Basic ')).toBe(true);
    expect(init.body).not.toContain(KEY_SECRET);
    expect(JSON.parse(init.body)).toMatchObject({
      amount: 50000,
      currency: 'INR',
    });
  });

  it('rejects a non-INR order before calling Razorpay', async () => {
    const provider = new RazorpayPaymentProvider(config());
    provider.fetchImpl = jest.fn();
    await expect(
      provider.createIntent({
        amountCents: 50000,
        currency: 'USD',
        userId: 'user-1',
        idempotencyKey: 'idem-key-1234',
      }),
    ).rejects.toThrow(/INR/);
    expect(provider.fetchImpl).not.toHaveBeenCalled();
  });
});
