import { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  activateHost,
  closeApp,
  createTestApp,
  me,
  prisma,
  registerAdmin,
  registerUser,
  resetDatabase,
} from './helpers';

describe('calling rtc token (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    await resetDatabase();
    app = await createTestApp();
  });

  afterEach(async () => {
    await closeApp(app);
  });

  async function fundAndOpenCall() {
    const alice = await registerUser(app, 'alice@example.com', 'Alice');
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const admin = await registerAdmin(app);
    const bobUser = await me(app, bob.accessToken);
    await activateHost({
      app,
      hostToken: bob.accessToken,
      adminToken: admin.accessToken,
      hostUserId: bobUser.id,
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/payments/intents',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { amountCents: 50_000, idempotencyKey: `fund-${Date.now()}` },
    });
    const aliceUser = await me(app, alice.accessToken);
    const payment = await prisma.payment.findFirstOrThrow({
      where: { userId: aliceUser.id },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/dev/payments/simulate-webhook',
      payload: {
        providerPaymentId: payment.providerPaymentId,
        status: 'succeeded',
        amountCents: 50_000,
      },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { calleeId: bobUser.id, callType: 'VOICE' },
    });
    expect(created.statusCode).toBe(201);
    const call = JSON.parse(created.body) as { id: string };
    return { alice, bob, bobUser, callId: call.id };
  }

  it('denies rtc-token while ringing and after end; allows after accept', async () => {
    const { alice, bob, callId } = await fundAndOpenCall();
    const carol = await registerUser(app, 'carol@example.com', 'Carol');

    const ringingToken = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${callId}/rtc-token`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(ringingToken.statusCode).toBe(409);
    expect(JSON.parse(ringingToken.body).error.code).toBe('CALL_RTC_FORBIDDEN');

    const idor = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${callId}/rtc-token`,
      headers: { authorization: `Bearer ${carol.accessToken}` },
    });
    expect(idor.statusCode).toBe(403);

    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${callId}/accept`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(accept.statusCode).toBe(201);

    const token = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${callId}/rtc-token`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(token.statusCode).toBe(201);
    const body = JSON.parse(token.body) as {
      token: string;
      channelName: string;
      uid: number;
    };
    expect(body.token.length).toBeGreaterThan(8);
    expect(body.channelName).toBe(`gmatez-call-${callId}`);
    expect(body.uid).toBe(1);

    const renew = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${callId}/rtc-token`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(renew.statusCode).toBe(201);

    await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${callId}/end`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });

    const afterEnd = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${callId}/rtc-token`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(afterEnd.statusCode).toBe(409);
  });

  it('double end is idempotent for settlement', async () => {
    const { alice, bob, callId } = await fundAndOpenCall();
    await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${callId}/accept`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });

    await prisma.call.update({
      where: { id: callId },
      data: { connectedAt: new Date(Date.now() - 60_000) },
    });

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/calls/${callId}/end`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/calls/${callId}/end`,
        headers: { authorization: `Bearer ${bob.accessToken}` },
      }),
    ]);
    expect(
      [a.statusCode, b.statusCode].every((s) => s === 201 || s === 409),
    ).toBe(true);
    const call = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
    expect(call.status).toBe('ENDED');
    const charges = await prisma.walletLedgerEntry.count({
      where: {
        idempotencyKey: `call:${callId}:charge`,
      },
    });
    expect(charges).toBeLessThanOrEqual(1);
  });
});
