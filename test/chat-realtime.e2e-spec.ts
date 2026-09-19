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

describe('chat realtime (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    await resetDatabase();
    app = await createTestApp();
  });

  afterEach(async () => {
    await closeApp(app);
  });

  it('creates one conversation under concurrent open requests', async () => {
    const alice = await registerUser(app, 'alice@example.com', 'Alice');
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const bobUser = await me(app, bob.accessToken);

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: { userId: bobUser.id },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: { userId: bobUser.id },
      }),
    ]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const idA = JSON.parse(a.body).id as string;
    const idB = JSON.parse(b.body).id as string;
    expect(idA).toBe(idB);
    const count = await prisma.conversation.count();
    expect(count).toBe(1);
  });

  it('idempotent message send creates one row and blocks IDOR', async () => {
    const alice = await registerUser(app, 'alice@example.com', 'Alice');
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const carol = await registerUser(app, 'carol@example.com', 'Carol');
    const bobUser = await me(app, bob.accessToken);
    const open = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { userId: bobUser.id },
    });
    const conversationId = JSON.parse(open.body).id as string;

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${conversationId}/messages`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {
          body: 'hello bob',
          idempotencyKey: 'same-key-12345678',
        },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${conversationId}/messages`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {
          body: 'hello bob',
          idempotencyKey: 'same-key-12345678',
        },
      }),
    ]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(JSON.parse(first.body).id).toBe(JSON.parse(second.body).id);
    expect(JSON.parse(first.body).status).toBe('SENT');
    expect(await prisma.message.count()).toBe(1);

    const idor = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${carol.accessToken}` },
    });
    expect(idor.statusCode).toBe(404);

    const idorSend = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${carol.accessToken}` },
      payload: { body: 'intrude', idempotencyKey: 'carol-key-12345678' },
    });
    expect(idorSend.statusCode).toBe(404);

    const idorRead = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/read`,
      headers: { authorization: `Bearer ${carol.accessToken}` },
    });
    expect(idorRead.statusCode).toBe(404);
  });

  it('blocks messaging after block and supports read + pagination', async () => {
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

    const open = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { userId: bobUser.id },
    });
    const conversationId = JSON.parse(open.body).id as string;

    for (let i = 0; i < 5; i += 1) {
      const send = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${conversationId}/messages`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
        payload: {
          body: `msg-${i}`,
          idempotencyKey: `page-key-${i}-xxxxxx`,
        },
      });
      expect(send.statusCode).toBe(201);
    }

    const page = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages?limit=2`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(page.statusCode).toBe(200);
    const body = JSON.parse(page.body) as {
      items: Array<{ body: string }>;
      nextCursor: string | null;
    };
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeTruthy();

    const read = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/read`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(read.statusCode).toBe(201);

    const unread = await prisma.message.count({
      where: {
        conversationId,
        senderId: { not: bobUser.id },
        readAt: null,
      },
    });
    expect(unread).toBe(0);

    await app.inject({
      method: 'POST',
      url: '/api/v1/blocks',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { userId: bobUser.id },
    });

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        body: 'should fail',
        idempotencyKey: 'blocked-key-123456',
      },
    });
    expect(blocked.statusCode).toBe(403);
    expect(JSON.parse(blocked.body).error.code).toBe('MESSAGE_BLOCKED');

    const reopen = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { userId: (await me(app, alice.accessToken)).id },
    });
    expect(reopen.statusCode).toBe(403);
  });
});
