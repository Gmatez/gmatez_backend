import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';
import { loadConfig } from './config/app-config';

async function bootstrap() {
  const config = loadConfig();
  const adapter = new FastifyAdapter({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'password',
          'otp',
          'accessToken',
          'refreshToken',
          'clientSecret',
        ],
        censor: '[redacted]',
      },
    },
    requestIdHeader: 'x-request-id',
    genReqId: (req: { headers: Record<string, unknown> }) =>
      (req.headers['x-request-id'] as string | undefined) ??
      crypto.randomUUID(),
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    {
      rawBody: true,
    },
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(compress);
  app.enableCors({
    origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  app.useWebSocketAdapter(new IoAdapter(app));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Enterprise Social Calling API')
    .setDescription(
      'Modular monolith backend for authenticated discovery, wallet-billed calling, and payments. Media is handled by an external provider.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .addServer(`http://127.0.0.1:${config.PORT}`, 'Current environment')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/v1/docs', app, document);

  await app.listen(config.PORT, config.HOST);
  Logger.log(`Listening on http://${config.HOST}:${config.PORT}/api/v1/docs`);
}

void bootstrap().catch((error: unknown) => {
  Logger.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
