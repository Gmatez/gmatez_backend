import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getRequestContext } from '../context/request-context';
import { AppError, ErrorCodes } from '../errors/app-error';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = getRequestContext()?.requestId ?? 'unknown';

    if (exception instanceof AppError) {
      reply.status(exception.status).send({
        error: {
          code: exception.code,
          message: exception.message,
          requestId,
          details: exception.details,
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ??
            exception.message);
      reply.status(status).send({
        error: {
          code:
            status === 401
              ? ErrorCodes.UNAUTHENTICATED
              : ErrorCodes.VALIDATION_FAILED,
          message: Array.isArray(message) ? message.join('; ') : message,
          requestId,
        },
      });
      return;
    }

    this.logger.error(
      {
        err: exception instanceof Error ? exception.message : 'unknown',
        requestId,
        method: request.method,
        url: request.url,
      },
      'Unhandled exception',
    );

    reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: {
        code: ErrorCodes.INTERNAL,
        message: 'Internal server error',
        requestId,
      },
    });
  }
}
