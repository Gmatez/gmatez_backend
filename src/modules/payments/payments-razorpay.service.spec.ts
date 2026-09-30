import { Prisma } from '@prisma/client';
import { hmacSha256 } from '../../common/crypto/hashing';
import { PaymentsService } from './payments.service';

const WEBHOOK_SECRET = 'razorpay-webhook-secret-test';

function capturedPayload(amount = 50000, currency = 'INR') {
  return JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_test_1',
          amount,
          currency,
          status: 'captured',
          order_id: 'order_test_1',
        },
      },
    },
  });
}

function harness(options?: { missing?: boolean }) {
  const state = {
    payment: {
      id: 'pay-int',
      userId: 'user-1',
      amountCents: 50000,
      creditCents: 55000,
      currency: 'INR',
      status: 'REQUIRES_ACTION' as string,
      provider: 'razorpay',
      providerPaymentId: 'order_test_1',
      providerCaptureId: null as string | null,
      refundStatus: 'NONE',
      refundAttempt: 0,
      reconciliationStatus: 'PENDING',
      failureReason: null as string | null,
      idempotencyKey: 'idem-1',
      clientSecret: null,
      rechargePlanId: 'plan-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      capturedAt: null as Date | null,
      providerRefundId: null,
      refundedAmountCents: 0,
    },
    events: new Set<string>(),
    credits: [] as string[],
  };
  const findPayment = async (where: {
    id?: string;
    providerPaymentId?: string;
    idempotencyKey?: string;
  }) => {
    if (options?.missing) {
      return null;
    }
    if (
      where.providerPaymentId &&
      where.providerPaymentId !== state.payment.providerPaymentId
    ) {
      return null;
    }
    if (where.id && where.id !== state.payment.id) {
      return null;
    }
    return state.payment;
  };
  const tx = {
    providerEvent: {
      create: jest.fn(async ({ data }: { data: { eventId: string } }) => {
        if (state.events.has(data.eventId)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint', {
            code: 'P2002',
            clientVersion: '6.15.0',
          });
        }
        state.events.add(data.eventId);
        return data;
      }),
    },
    payment: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { id?: string; providerPaymentId?: string };
        }) => findPayment(where),
      ),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.payment, data);
        return state.payment;
      }),
    },
    wallet: {
      findUnique: jest.fn(async () => ({
        id: 'wallet-1',
        userId: 'user-1',
        currency: 'INR',
        availableBalanceCents: 0,
        heldBalanceCents: 0,
      })),
    },
    walletLedgerEntry: {
      count: jest.fn(async () => 0),
    },
  };
  let chain = Promise.resolve();
  const prisma = {
    payment: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { id?: string; providerPaymentId?: string };
        }) => {
          const row = await findPayment(where);
          return row ? { ...row } : null;
        },
      ),
      findUniqueOrThrow: jest.fn(async () => ({ ...state.payment })),
      update: tx.payment.update,
      create: jest.fn(),
    },
    $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => {
      const run = chain.then(() => fn(tx));
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }),
  };
  const wallet = {
    ensureForUser: jest.fn(),
    applyLedger: jest.fn(async (mutation: { idempotencyKey: string }) => {
      if (state.credits.includes(mutation.idempotencyKey)) {
        return { duplicate: true };
      }
      state.credits.push(mutation.idempotencyKey);
      return { duplicate: false };
    }),
  };
  const provider = {
    name: 'razorpay',
    verifyWebhook: jest.fn(
      (body: string, signature?: string) =>
        signature === hmacSha256(WEBHOOK_SECRET, body),
    ),
    parseWebhook: jest.fn(),
    fetchPayment: jest.fn(),
    createIntent: jest.fn(),
    verifyCheckoutSignature: jest.fn(() => true),
  };
  const service = new PaymentsService(
    prisma as never,
    wallet as never,
    { get: () => 'rzp_test_public' } as never,
    provider,
  );
  return { service, state, provider, wallet };
}

describe('Razorpay wallet credit', () => {
  it('credits once for a valid captured webhook', async () => {
    const { service, state, provider } = harness();
    const body = capturedPayload();
    provider.parseWebhook.mockReturnValue({
      eventId: 'evt_1',
      providerPaymentId: 'order_test_1',
      providerCaptureId: 'pay_test_1',
      status: 'succeeded',
      amountCents: 50000,
      currency: 'INR',
    });
    provider.fetchPayment.mockResolvedValue({
      id: 'pay_test_1',
      orderId: 'order_test_1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'captured',
    });
    const result = await service.handleRazorpayWebhook(
      body,
      hmacSha256(WEBHOOK_SECRET, body),
      'evt_1',
    );
    expect(result).toMatchObject({ credited: true, status: 'SUCCEEDED' });
    expect(state.credits).toEqual(['payment:pay-int:credit']);
    expect(state.payment.status).toBe('SUCCEEDED');
    expect(state.payment.creditCents).toBe(55000);
  });

  it('rejects an invalid signature and does not credit', async () => {
    const { service, state, wallet } = harness();
    await expect(
      service.handleRazorpayWebhook(
        capturedPayload(),
        'not-a-signature',
        'evt_1',
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(wallet.applyLedger).not.toHaveBeenCalled();
    expect(state.credits).toHaveLength(0);
    expect(state.payment.status).toBe('REQUIRES_ACTION');
  });

  it('does not credit a duplicate webhook', async () => {
    const { service, state, provider } = harness();
    const body = capturedPayload();
    provider.parseWebhook.mockReturnValue({
      eventId: 'evt_1',
      providerPaymentId: 'order_test_1',
      providerCaptureId: 'pay_test_1',
      status: 'succeeded',
      amountCents: 50000,
      currency: 'INR',
    });
    provider.fetchPayment.mockResolvedValue({
      id: 'pay_test_1',
      orderId: 'order_test_1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'captured',
    });
    const signature = hmacSha256(WEBHOOK_SECRET, body);
    await service.handleRazorpayWebhook(body, signature, 'evt_1');
    const second = await service.handleRazorpayWebhook(
      body,
      signature,
      'evt_1',
    );
    expect(second).toMatchObject({ duplicate: true });
    expect(state.credits).toEqual(['payment:pay-int:credit']);
  });

  it('credits once when the same webhook is delivered concurrently', async () => {
    const { service, state, provider } = harness();
    const body = capturedPayload();
    provider.parseWebhook.mockReturnValue({
      eventId: 'evt_race',
      providerPaymentId: 'order_test_1',
      providerCaptureId: 'pay_test_1',
      status: 'succeeded',
      amountCents: 50000,
      currency: 'INR',
    });
    provider.fetchPayment.mockResolvedValue({
      id: 'pay_test_1',
      orderId: 'order_test_1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'captured',
    });
    const signature = hmacSha256(WEBHOOK_SECRET, body);
    const [first, second] = await Promise.all([
      service.handleRazorpayWebhook(body, signature, 'evt_race'),
      service.handleRazorpayWebhook(body, signature, 'evt_race'),
    ]);
    expect(
      [first, second].filter((row) => 'credited' in row && row.credited),
    ).toHaveLength(1);
    expect(state.credits).toEqual(['payment:pay-int:credit']);
  });

  it('does not credit when the captured amount does not match the payment', async () => {
    const { service, state, wallet, provider } = harness();
    const body = capturedPayload(100);
    provider.parseWebhook.mockReturnValue({
      eventId: 'evt_amt',
      providerPaymentId: 'order_test_1',
      providerCaptureId: 'pay_test_1',
      status: 'succeeded',
      amountCents: 100,
      currency: 'INR',
    });
    provider.fetchPayment.mockResolvedValue({
      id: 'pay_test_1',
      orderId: 'order_test_1',
      amountPaise: 100,
      currency: 'INR',
      status: 'captured',
    });
    await expect(
      service.handleRazorpayWebhook(
        body,
        hmacSha256(WEBHOOK_SECRET, body),
        'evt_amt',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(wallet.applyLedger).not.toHaveBeenCalled();
    expect(state.credits).toHaveLength(0);
    expect(state.payment.reconciliationStatus).toBe('AMOUNT_MISMATCH');
  });

  it('does not credit when the currency does not match', async () => {
    const { service, state, provider } = harness();
    const body = capturedPayload(50000, 'USD');
    provider.parseWebhook.mockReturnValue({
      eventId: 'evt_cur',
      providerPaymentId: 'order_test_1',
      providerCaptureId: 'pay_test_1',
      status: 'succeeded',
      amountCents: 50000,
      currency: 'USD',
    });
    provider.fetchPayment.mockResolvedValue({
      id: 'pay_test_1',
      orderId: 'order_test_1',
      amountPaise: 50000,
      currency: 'USD',
      status: 'captured',
    });
    await expect(
      service.handleRazorpayWebhook(
        body,
        hmacSha256(WEBHOOK_SECRET, body),
        'evt_cur',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(state.credits).toHaveLength(0);
    expect(state.payment.reconciliationStatus).toBe('CURRENCY_MISMATCH');
  });

  it('does not mutate a wallet for an unknown order', async () => {
    const { service, state, provider } = harness({ missing: true });
    const body = capturedPayload();
    provider.parseWebhook.mockReturnValue({
      eventId: 'evt_missing',
      providerPaymentId: 'order_test_1',
      providerCaptureId: 'pay_test_1',
      status: 'succeeded',
      amountCents: 50000,
      currency: 'INR',
    });
    provider.fetchPayment.mockResolvedValue({
      id: 'pay_test_1',
      orderId: 'order_test_1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'captured',
    });
    await expect(
      service.handleRazorpayWebhook(
        body,
        hmacSha256(WEBHOOK_SECRET, body),
        'evt_missing',
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(state.credits).toHaveLength(0);
  });

  it('marks a failed payment without a ledger credit', async () => {
    const { service, state, provider, wallet } = harness();
    const body = JSON.stringify({ event: 'payment.failed' });
    provider.parseWebhook.mockReturnValue({
      eventId: 'evt_fail',
      providerPaymentId: 'order_test_1',
      providerCaptureId: 'pay_fail',
      status: 'failed',
      amountCents: 50000,
      currency: 'INR',
      failureReason: 'Payment failed',
    });
    const result = await service.handleRazorpayWebhook(
      body,
      hmacSha256(WEBHOOK_SECRET, body),
      'evt_fail',
    );
    expect(result).toMatchObject({ status: 'FAILED', credited: false });
    expect(wallet.applyLedger).not.toHaveBeenCalled();
    expect(state.payment.status).toBe('FAILED');
  });
});
