import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { closeApp, createTestApp, prisma, resetDatabase } from './helpers';

describe('critical flows (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function register(email: string, displayName: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'ChangeMe123!', displayName },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body) as { accessToken: string };
  }

  async function me(token: string) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { id: string };
  }

  it('rejects unauthenticated access', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/wallet' });
    expect(res.statusCode).toBe(401);
  });

  it('registers, logs in, and returns a wallet', async () => {
    const session = await register('alice@example.com', 'Alice');
    const wallet = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(wallet.statusCode).toBe(200);
    expect(JSON.parse(wallet.body).availableBalanceCents).toBe(0);
  });

  it('credits the wallet once for duplicate payment webhooks', async () => {
    const session = await register('alice@example.com', 'Alice');
    const intent = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/intents',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { amountCents: 2500, idempotencyKey: 'topup-alice-1' },
    });
    expect(intent.statusCode).toBe(201);
    const payment = JSON.parse(intent.body) as {
      providerPaymentId: string;
      amountCents: number;
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/dev/payments/simulate-webhook',
      payload: {
        providerPaymentId: payment.providerPaymentId,
        status: 'succeeded',
        amountCents: 2500,
      },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/dev/payments/simulate-webhook',
      payload: {
        providerPaymentId: payment.providerPaymentId,
        status: 'succeeded',
        amountCents: 2500,
      },
    });
    expect(JSON.parse(second.body).duplicate).toBe(true);

    const wallet = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(JSON.parse(wallet.body).availableBalanceCents).toBe(2500);
  });

  it('walks a call from ring to billed end', async () => {
    const alice = await register('alice@example.com', 'Alice');
    const bob = await register('bob@example.com', 'Bob');
    const aliceUser = await me(alice.accessToken);
    const bobUser = await me(bob.accessToken);

    await app.inject({
      method: 'POST',
      url: '/api/v1/payments/intents',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { amountCents: 5000, idempotencyKey: 'alice-call-funds' },
    });
    const payment = await prisma.payment.findFirstOrThrow({
      where: { userId: aliceUser.id },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/dev/payments/simulate-webhook',
      payload: {
        providerPaymentId: payment.providerPaymentId,
        status: 'succeeded',
        amountCents: 5000,
      },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { calleeId: bobUser.id },
    });
    expect(created.statusCode).toBe(201);
    const call = JSON.parse(created.body) as {
      id: string;
      status: string;
      providerSessionId: string;
    };
    expect(call.status).toBe('RINGING');

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(accepted.statusCode).toBe(201);

    const connected = await app.inject({
      method: 'POST',
      url: '/api/v1/dev/calling/simulate-callback',
      payload: { sessionId: call.providerSessionId, type: 'connected' },
    });
    expect(connected.statusCode).toBe(201);

    await prisma.call.update({
      where: { id: call.id },
      data: { connectedAt: new Date(Date.now() - 60_000) },
    });

    const ended = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${call.id}/end`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(ended.statusCode).toBe(201);
    expect(JSON.parse(ended.body).status).toBe('ENDED');

    const wallet = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    const body = JSON.parse(wallet.body) as {
      availableBalanceCents: number;
      heldBalanceCents: number;
    };
    expect(body.heldBalanceCents).toBe(0);
    expect(body.availableBalanceCents).toBeLessThan(5000);
  });

  it('blocks IDOR on another user payment', async () => {
    const alice = await register('alice@example.com', 'Alice');
    const bob = await register('bob@example.com', 'Bob');
    const intent = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/intents',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { amountCents: 1000, idempotencyKey: 'alice-only' },
    });
    const payment = JSON.parse(intent.body) as { id: string };
    const peek = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/${payment.id}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(peek.statusCode).toBe(404);
  });
});
