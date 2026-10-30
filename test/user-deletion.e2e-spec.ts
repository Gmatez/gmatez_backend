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

describe('user self-deletion / GDPR erasure (e2e)', () => {
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

  it('anonymizes the account, revokes the session, and blocks future login', async () => {
    const session = await registerUser(app, 'alice@example.com', 'Alice');
    const user = await me(app, session.accessToken);

    const deletion = await app.inject({
      method: 'DELETE',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(deletion.statusCode).toBe(204);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.status).toBe('DELETED');
    expect(row.email).toBe(`deleted+${user.id}@invalid.local`);
    expect(row.phone).toBeNull();

    const profile = await prisma.profile.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(profile.displayName).toBe('Deleted user');
    expect(profile.isDiscoverable).toBe(false);

    // The still-unexpired access token must now be rejected server-side,
    // not just client-side (JwtAuthGuard re-checks status per request).
    const afterDeletion = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(afterDeletion.statusCode).toBe(401);

    // A deleted account's password hash must stay structurally valid so
    // argon2.verify() returns false instead of throwing (which would 500
    // instead of cleanly 401ing).
    const loginAttempt = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'alice@example.com', password: 'ChangeMe123!' },
    });
    expect(loginAttempt.statusCode).toBe(401);

    const auditEntry = await prisma.auditLog.findFirst({
      where: { targetId: user.id, action: 'user.self_delete' },
    });
    expect(auditEntry).not.toBeNull();
  });

  it('scrubs host PII and payout destination details', async () => {
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const bobUser = await me(app, bob.accessToken);
    const admin = await registerAdmin(app);
    await activateHost({
      app,
      hostToken: bob.accessToken,
      adminToken: admin.accessToken,
      hostUserId: bobUser.id,
      online: false,
    });
    await prisma.payoutDestination.create({
      data: {
        userId: bobUser.id,
        type: 'BANK',
        label: "Bob's savings",
        detailsJson: { accountLast4: '4321' },
      },
    });

    const deletion = await app.inject({
      method: 'DELETE',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(deletion.statusCode).toBe(204);

    const host = await prisma.hostProfile.findUniqueOrThrow({
      where: { userId: bobUser.id },
    });
    expect(host.identityCardNumber).toBeNull();
    expect(host.idProofLast4).toBeNull();
    expect(host.internalNote).toBeNull();
    expect(host.languages).toEqual([]);

    const destination = await prisma.payoutDestination.findFirstOrThrow({
      where: { userId: bobUser.id },
    });
    expect(destination.label).toBe('');
    expect(destination.detailsJson).toEqual({});
  });

  it('refuses to delete the account while a call is active', async () => {
    const alice = await registerUser(app, 'alice@example.com', 'Alice');
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const bobUser = await me(app, bob.accessToken);
    const admin = await registerAdmin(app);
    await activateHost({
      app,
      hostToken: bob.accessToken,
      adminToken: admin.accessToken,
      hostUserId: bobUser.id,
      online: true,
    });

    const intent = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/intents',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { amountCents: 5000, idempotencyKey: 'alice-delete-guard' },
    });
    const aliceUser = await me(app, alice.accessToken);
    const payment = await prisma.payment.findFirstOrThrow({
      where: { userId: aliceUser.id },
    });
    expect(intent.statusCode).toBe(201);
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
      payload: { calleeId: bobUser.id, callType: 'VOICE' },
    });
    expect(created.statusCode).toBe(201);

    const deletion = await app.inject({
      method: 'DELETE',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(deletion.statusCode).toBe(409);
    expect(JSON.parse(deletion.body).error.code).toBe('CONFLICT');

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: aliceUser.id },
    });
    expect(row.status).toBe('ACTIVE');
  });
});
