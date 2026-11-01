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

describe('admin active calls (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    await resetDatabase();
    app = await createTestApp();
  });

  afterEach(async () => {
    await closeApp(app);
  });

  it('lists only CONNECTED calls, with both participants balances', async () => {
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
    const call = JSON.parse(created.body) as { id: string };

    // Not connected yet — ringing shouldn't show up as an active call.
    const beforeAccept = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/calls/active',
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(beforeAccept.statusCode).toBe(200);
    expect(JSON.parse(beforeAccept.body)).toEqual([]);

    await app.inject({
      method: 'POST',
      url: `/api/v1/calls/${call.id}/accept`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    await prisma.call.update({
      where: { id: call.id },
      data: { status: 'CONNECTED', connectedAt: new Date() },
    });

    const afterConnect = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/calls/active',
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(afterConnect.statusCode).toBe(200);
    const rows = JSON.parse(afterConnect.body) as Array<{
      id: string;
      callType: string;
      caller: { id: string; displayName: string | null; availableBalanceCents: number };
      host: { id: string; displayName: string | null; availableBalanceCents: number };
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(call.id);
    expect(rows[0].caller.id).toBe(aliceUser.id);
    expect(rows[0].host.id).toBe(bobUser.id);
    expect(rows[0].caller.availableBalanceCents).toBeGreaterThan(0);
  });

  it('is forbidden for a non-admin', async () => {
    const alice = await registerUser(app, 'alice2@example.com', 'Alice');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/calls/active',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
