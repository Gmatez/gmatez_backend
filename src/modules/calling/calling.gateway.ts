import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import { AppConfigService } from '../../config/app-config';
import { RedisService } from '../../redis/redis.service';
import { RealtimeEmitter } from '../../realtime/realtime-emitter';
import { ChatService } from '../chat/chat.service';
import { CallingService } from './calling.service';

@WebSocketGateway({
  cors: { origin: true },
  namespace: '/ws',
})
export class CallingGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
    private readonly calling: CallingService,
    private readonly realtime: RealtimeEmitter,
    private readonly chat: ChatService,
  ) {}

  afterInit(server: Server): void {
    this.realtime.register((userId, event, payload) => {
      server.to(`user:${userId}`).emit(event, payload);
    });
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token =
        (client.handshake.auth?.token as string | undefined) ??
        client.handshake.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        client.disconnect(true);
        return;
      }
      const payload = await this.jwt.verifyAsync<{ sub: string; typ: string }>(
        token,
        {
          secret: this.config.get('JWT_ACCESS_SECRET'),
        },
      );
      if (payload.typ !== 'access') {
        client.disconnect(true);
        return;
      }
      client.data.userId = payload.sub;
      await client.join(`user:${payload.sub}`);
      await this.redis.client.set(`presence:${payload.sub}`, '1', 'EX', 60);
      this.realtime.emitToUser(payload.sub, 'presence.updated', {
        userId: payload.sub,
        presence: 'ONLINE',
      });
    } catch {
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return;
    }
    const remaining = await this.server.in(`user:${userId}`).fetchSockets();
    if (remaining.length <= 1) {
      await this.redis.client.del(`presence:${userId}`);
      this.realtime.emitToUser(userId, 'presence.updated', {
        userId,
        presence: 'OFFLINE',
      });
    }
  }

  @SubscribeMessage('presence.ping')
  async ping(@ConnectedSocket() client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (!userId) {
      return { ok: false };
    }
    await this.redis.client.set(`presence:${userId}`, '1', 'EX', 60);
    return { ok: true };
  }

  @SubscribeMessage('call.heartbeat')
  async heartbeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { callId: string },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId || !body?.callId) {
      return { ok: false };
    }
    await this.calling.heartbeat(body.callId, userId);
    return { ok: true };
  }

  @SubscribeMessage('message.typing')
  async typing(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string; typing?: boolean },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId || !body?.conversationId) {
      return { ok: false };
    }
    const peerId = await this.chat.peerIdFor(userId, body.conversationId);
    if (!peerId) {
      return { ok: false };
    }
    this.realtime.emitToUser(peerId, 'message.typing', {
      conversationId: body.conversationId,
      userId,
      typing: body.typing !== false,
    });
    return { ok: true };
  }
}
