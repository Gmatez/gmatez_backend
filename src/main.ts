import { HttpStatus, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { loadConfig } from './config/app-config';
import { ErrorCodes } from './common/errors/app-error';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

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

/**
 * Fastify can reject a request before it ever reaches Nest's own request
 * pipeline — so GlobalExceptionFilter, which only sees exceptions thrown
 * inside that pipeline, never gets a chance to shape the response.
 * Confirmed by chaos testing: an oversized path parameter returned
 * Fastify's native `{"error":"Bad Request","code":"FST_ERR_..."}` shape
 * instead of this app's `{"error":{"code","message"}}` convention used
 * everywhere else. This is the shared shaping logic both hooks below use
 * so every response looks the same regardless of which layer rejected it.
 */
function sendShapedError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const status =
    typeof error.statusCode === 'number'
      ? error.statusCode
      : HttpStatus.INTERNAL_SERVER_ERROR;
  reply.status(status).send({
    error: {
      code:
        status >= 500
          ? ErrorCodes.INTERNAL
          : status === 401
            ? ErrorCodes.UNAUTHENTICATED
            : ErrorCodes.VALIDATION_FAILED,
      message: error.message,
      requestId: request.id,
    },
  });
}

// Catches any other Fastify-level error that reaches this hook (most
// in-pipeline errors never do — Nest's own route-handler wrapper catches
// those and routes them to GlobalExceptionFilter directly).
function registerFastifyErrorShape(adapter: FastifyAdapter): void {
  adapter.getInstance().setErrorHandler(sendShapedError);
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
    // FST_ERR_BAD_URL / FST_ERR_MAX_PARAM_LENGTH / FST_ERR_ASYNC_CONSTRAINT
    // are thrown by Fastify's router before a request reaches setErrorHandler
    // at all — this is the only hook that can reshape them (confirmed by
    // chaos testing: without this, an oversized path param returned
    // Fastify's raw error shape no matter what registerFastifyErrorShape did).
    frameworkErrors: sendShapedError,
  });

  registerEmptySafeJsonParser(adapter);
  registerFastifyErrorShape(adapter);

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
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

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
