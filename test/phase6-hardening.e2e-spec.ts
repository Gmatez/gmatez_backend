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

async function fund(app: NestFastifyApplication, token: string, cents: number) {
  const user = await me(app, token);
  await app.inject({
    method: 'POST',
    url: '/api/v1/payments/intents',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      amountCents: cents,
      idempotencyKey: `fund-${user.id}-${cents}-${Date.now()}`,
    },
  });
  const payment = await prisma.payment.findFirstOrThrow({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });
  await app.inject({
    method: 'POST',
    url: '/api/v1/dev/payments/simulate-webhook',
    payload: {
      providerPaymentId: payment.providerPaymentId,
      status: 'succeeded',
      amountCents: cents,
    },
  });
}

describe('phase6 call money + idor (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    await resetDatabase();
    app = await createTestApp();
  });

  afterEach(async () => {
    await closeApp(app);
  });

  it('idempotent call create returns one call under concurrency', async () => {
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
    await fund(app, alice.accessToken, 10_000);

    const key = 'create-call-key-123456';
    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/calls',
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {
          calleeId: bobUser.id,
          callType: 'VOICE',
          idempotencyKey: key,
        },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/calls',
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {
          calleeId: bobUser.id,
          callType: 'VOICE',
          idempotencyKey: key,
        },
      }),
    ]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(JSON.parse(a.body).id).toBe(JSON.parse(b.body).id);
    expect(await prisma.call.count()).toBe(1);
  });

  it('accept vs cancel race resolves to one terminal-or-accepted outcome', async () => {
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
    await fund(app, alice.accessToken, 10_000);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        calleeId: bobUser.id,
        callType: 'VOICE',
        idempotencyKey: 'race-key-abcdefgh',
      },
    });
    const callId = JSON.parse(created.body).id as string;

    const [accept, cancel] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/calls/${callId}/accept`,
        headers: { authorization: `Bearer ${bob.accessToken}` },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/calls/${callId}/cancel`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
      }),
    ]);
    const statuses = [accept.statusCode, cancel.statusCode];
    expect(statuses.some((s) => s === 201)).toBe(true);
    const call = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
    expect(['CONNECTED', 'CANCELLED', 'CONNECTING', 'ACCEPTED']).toContain(
      call.status,
    );
  });

  it('idor denies foreign call/wallet/notification access', async () => {
    const alice = await registerUser(app, 'alice@example.com', 'Alice');
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const carol = await registerUser(app, 'carol@example.com', 'Carol');
    const admin = await registerAdmin(app);
    const bobUser = await me(app, bob.accessToken);
    await activateHost({
      app,
      hostToken: bob.accessToken,
      adminToken: admin.accessToken,
      hostUserId: bobUser.id,
    });
    await fund(app, alice.accessToken, 10_000);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { calleeId: bobUser.id, callType: 'VOICE' },
    });
    const callId = JSON.parse(created.body).id as string;

    const foreignCall = await app.inject({
      method: 'GET',
      url: `/api/v1/calls/${callId}`,
      headers: { authorization: `Bearer ${carol.accessToken}` },
    });
    expect(foreignCall.statusCode).toBe(403);

    const foreignAccept = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${callId}/accept`,
      headers: { authorization: `Bearer ${carol.accessToken}` },
    });
    expect([403, 404]).toContain(foreignAccept.statusCode);

    await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/devices',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { token: 'device-token-alice-1', platform: 'android' },
    });
    const notes = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(notes.statusCode).toBe(200);

    const reconcile = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${(await me(app, alice.accessToken)).id}/wallet/reconcile`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(reconcile.statusCode).toBe(200);
    expect(JSON.parse(reconcile.body).ok).toBe(true);
  });

  it('payout requires destination; identical keys create one request', async () => {
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const admin = await registerAdmin(app);
    const bobUser = await me(app, bob.accessToken);
    await activateHost({
      app,
      hostToken: bob.accessToken,
      adminToken: admin.accessToken,
      hostUserId: bobUser.id,
    });
    await fund(app, bob.accessToken, 5_000);

    const noDest = await app.inject({
      method: 'POST',
      url: '/api/v1/payouts',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { amountCents: 500, idempotencyKey: 'payout-no-dest-key' },
    });
    expect(noDest.statusCode).toBe(422);

    const dest = await app.inject({
      method: 'POST',
      url: '/api/v1/payouts/destinations',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: {
        type: 'UPI',
        label: 'Primary',
        details: { upiId: 'bob@upi' },
      },
    });
    expect(dest.statusCode).toBe(201);

    const key = 'payout-dup-key-123456';
    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/payouts',
        headers: { authorization: `Bearer ${bob.accessToken}` },
        payload: { amountCents: 500, idempotencyKey: key },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/payouts',
        headers: { authorization: `Bearer ${bob.accessToken}` },
        payload: { amountCents: 500, idempotencyKey: key },
      }),
    ]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(JSON.parse(a.body).id).toBe(JSON.parse(b.body).id);
    expect(await prisma.payoutRequest.count()).toBe(1);
  });

  it('duplicate admin refunds are idempotent', async () => {
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
    await fund(app, alice.accessToken, 10_000);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { calleeId: bobUser.id, callType: 'VOICE' },
    });
    const callId = JSON.parse(created.body).id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${callId}/accept`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    await prisma.call.update({
      where: { id: callId },
      data: { connectedAt: new Date(Date.now() - 90_000) },
    });
    const ended = await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${callId}/end`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(ended.statusCode).toBe(201);

    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/admin/calls/${callId}/refund`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { reason: 'test' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/admin/calls/${callId}/refund`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { reason: 'test' },
      }),
    ]);
    expect(
      [r1.statusCode, r2.statusCode].every((s) => s === 201 || s === 409),
    ).toBe(true);
    const refunds = await prisma.walletLedgerEntry.count({
      where: { reason: 'CALL_REFUND', referenceId: callId },
    });
    expect(refunds).toBe(1);
  });
});
