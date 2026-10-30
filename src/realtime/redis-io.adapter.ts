import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions } from 'socket.io';
import { RedisService } from '../redis/redis.service';

/**
 * Fans Socket.IO events (presence, call signaling, chat typing) out across
 * every instance via Redis pub/sub. Without this, a multi-instance
 * deployment silently drops events between users whose sockets land on
 * different instances — each instance only knows about its own local rooms.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(private readonly appContext: INestApplicationContext) {
    super(appContext);
  }

  async connectToRedis(): Promise<void> {
    const redis = this.appContext.get(RedisService);
    const pubClient = redis.client.duplicate();
    const subClient = redis.client.duplicate();
    pubClient.on('error', (err) =>
      this.logger.error(`Redis adapter pub client error: ${err.message}`),
    );
    subClient.on('error', (err) =>
      this.logger.error(`Redis adapter sub client error: ${err.message}`),
    );
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (!this.adapterConstructor) {
      throw new Error(
        'RedisIoAdapter.connectToRedis() must be called before the WS server is created',
      );
    }
    server.adapter(this.adapterConstructor);
    return server;
  }
}
