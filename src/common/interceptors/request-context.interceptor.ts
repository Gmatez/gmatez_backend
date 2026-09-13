import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Observable, tap } from 'rxjs';
import { requestContext } from '../context/request-context';
import { Logger } from '@nestjs/common';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestContextInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const header = request.headers['x-request-id'];
    const requestId =
      (Array.isArray(header) ? header[0] : header) ?? randomUUID();
    const traceHeader = request.headers['x-trace-id'];
    const traceId =
      (Array.isArray(traceHeader) ? traceHeader[0] : traceHeader) ?? requestId;
    const started = Date.now();
    const store: {
      requestId: string;
      traceId: string;
      userId?: string;
      route: string;
    } = {
      requestId,
      traceId,
      route: `${request.method} ${request.routeOptions?.url ?? request.url}`,
    };

    return new Observable((subscriber) => {
      requestContext.run(store, () => {
        reply.header('x-request-id', requestId);
        next
          .handle()
          .pipe(
            tap({
              finalize: () => {
                const durationMs = Date.now() - started;
                this.logger.log({
                  requestId,
                  traceId,
                  userId: store.userId,
                  route: store.route,
                  status: reply.statusCode,
                  durationMs,
                  env: process.env.NODE_ENV,
                });
              },
            }),
          )
          .subscribe(subscriber);
      });
    });
  }
}
