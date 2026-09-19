import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { io, Socket } from 'socket.io-client';
import {
  closeApp,
  createListeningTestApp,
  me,
  prisma,
  registerUser,
  resetDatabase,
} from './helpers';

function connectWs(
  wsUrl: string,
  token?: string,
): Promise<{ socket: Socket; connected: boolean }> {
  return new Promise((resolve) => {
    const socket = io(wsUrl, {
      transports: ['websocket'],
      forceNew: true,
      auth: token ? { token } : {},
      reconnection: false,
      timeout: 4000,
    });
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      // Server may accept then immediately disconnect unauthorized clients.
      setTimeout(() => {
        resolve({ socket, connected: socket.connected });
      }, 400);
    };
    socket.on('connect', finish);
    socket.on('connect_error', finish);
    setTimeout(finish, 4500);
  });
}

describe('socket security (e2e)', () => {
  let app: NestFastifyApplication;
  let wsUrl: string;

  beforeEach(async () => {
    await resetDatabase();
    const listening = await createListeningTestApp();
    app = listening.app;
    wsUrl = listening.wsUrl;
  });

  afterEach(async () => {
    await closeApp(app);
  });

  it('rejects unauthenticated and invalid JWT sockets', async () => {
    const none = await connectWs(wsUrl);
    expect(none.connected).toBe(false);
    none.socket.close();

    const bad = await connectWs(wsUrl, 'not-a-jwt');
    expect(bad.connected).toBe(false);
    bad.socket.close();
  });

  it('rejects expired JWT and suspended users', async () => {
    const alice = await registerUser(app, 'alice@example.com', 'Alice');
    const aliceUser = await me(app, alice.accessToken);
    const jwt = app.get(JwtService);

    const expired = await jwt.signAsync(
      {
        sub: aliceUser.id,
        typ: 'access',
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      { secret: process.env.JWT_ACCESS_SECRET },
    );
    const expiredConn = await connectWs(wsUrl, expired);
    expect(expiredConn.connected).toBe(false);
    expiredConn.socket.close();

    await prisma.user.update({
      where: { id: aliceUser.id },
      data: { status: 'SUSPENDED' },
    });
    const suspended = await connectWs(wsUrl, alice.accessToken);
    expect(suspended.connected).toBe(false);
    suspended.socket.close();
  });

  it('allows ACTIVE user and forbids foreign conversation rooms', async () => {
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
    expect(open.statusCode).toBe(201);
    const conversationId = JSON.parse(open.body).id as string;

    const ok = await connectWs(wsUrl, alice.accessToken);
    expect(ok.connected).toBe(true);

    const subscribeOk = await new Promise<{ ok?: boolean; code?: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('subscribe timeout')),
          3000,
        );
        ok.socket.emit(
          'conversation.subscribe',
          { conversationId },
          (ack: { ok?: boolean; code?: string }) => {
            clearTimeout(timer);
            resolve(ack ?? { ok: false });
          },
        );
      },
    );
    expect(subscribeOk.ok).toBe(true);

    const intruder = await connectWs(wsUrl, carol.accessToken);
    expect(intruder.connected).toBe(true);
    const forbidden = await new Promise<{ ok?: boolean; code?: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('forbidden timeout')),
          3000,
        );
        intruder.socket.emit(
          'conversation.subscribe',
          { conversationId },
          (ack: { ok?: boolean; code?: string }) => {
            clearTimeout(timer);
            resolve(ack ?? { ok: false });
          },
        );
      },
    );
    expect(forbidden.ok).toBe(false);
    expect(forbidden.code).toBe('SOCKET_ROOM_FORBIDDEN');

    const typing = await new Promise<{ ok?: boolean; code?: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('typing timeout')),
          3000,
        );
        intruder.socket.emit(
          'message.typing',
          { conversationId, typing: true },
          (ack: { ok?: boolean; code?: string }) => {
            clearTimeout(timer);
            resolve(ack ?? { ok: false });
          },
        );
      },
    );
    expect(typing.ok).toBe(false);
    expect(typing.code).toBe('SOCKET_ROOM_FORBIDDEN');

    ok.socket.close();
    intruder.socket.close();
  });
});
