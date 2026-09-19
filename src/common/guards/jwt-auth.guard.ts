import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import { AppConfigService } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { getRequestContext } from '../context/request-context';
import { AppError, ErrorCodes } from '../errors/app-error';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedUser } from '../decorators/current-user.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError(
        ErrorCodes.UNAUTHENTICATED,
        'Authentication required',
        401,
      );
    }
    const token = header.slice('Bearer '.length);
    let payload: { sub: string; role: 'USER' | 'ADMIN'; typ: string };
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new AppError(
        ErrorCodes.UNAUTHENTICATED,
        'Invalid access token',
        401,
      );
    }
    if (payload.typ !== 'access') {
      throw new AppError(
        ErrorCodes.UNAUTHENTICATED,
        'Invalid access token',
        401,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, status: true },
    });
    if (!user || user.status === 'DELETED') {
      throw new AppError(
        ErrorCodes.ACCOUNT_DELETED,
        'Authentication required',
        401,
      );
    }
    if (user.status === 'SUSPENDED') {
      throw new AppError(
        ErrorCodes.ACCOUNT_SUSPENDED,
        'Account is suspended',
        403,
      );
    }

    const auth: AuthenticatedUser = { userId: user.id, role: user.role };
    request.user = auth;
    const store = getRequestContext();
    if (store) {
      store.userId = user.id;
    }
    return true;
  }
}
