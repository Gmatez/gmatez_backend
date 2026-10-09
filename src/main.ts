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

function registerEmptySafeJsonParser(adapter: FastifyAdapter): void {
  // Flutter/Dio often sends Content-Type: application/json with an empty body
  // on accept/reject/end. Nest/Fastify default parser rejects that with 400.
  adapter.useBodyParser(
    'application/json',
    true,
    undefined,
    (req, body, done) => {
      const buffer = Buffer.isBuffer(body)
        ? body
        : Buffer.from(String(body ?? ''), 'utf8');
      (req as { rawBody?: string }).rawBody = buffer.toString('utf8');
      if (buffer.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(buffer.toString('utf8')) as unknown);
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
}

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
          'req.headers["x-razorpay-signature"]',
          'razorpay_signature',
          'key_secret',
          'RAZORPAY_KEY_SECRET',
          'RAZORPAY_WEBHOOK_SECRET',
          'identityCardNumber',
          'req.body.identityCardNumber',
          'dataBase64',
          'req.body.dataBase64',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: 8_000_000,
    requestIdHeader: 'x-request-id',
    genReqId: (req: { headers: Record<string, unknown> }) =>
      (req.headers['x-request-id'] as string | undefined) ??
      crypto.randomUUID(),
  });

  registerEmptySafeJsonParser(adapter);

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

  if (config.NODE_ENV !== 'production') {
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
    Logger.log(`Swagger at http://${config.HOST}:${config.PORT}/api/v1/docs`);
  }

  await app.listen(config.PORT, config.HOST);
  Logger.log(`Listening on http://${config.HOST}:${config.PORT}/api/v1`);
}

void bootstrap().catch((error: unknown) => {
  Logger.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
