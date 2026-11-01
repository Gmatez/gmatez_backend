import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export type AuthenticatedUser = {
  userId: string;
  role: 'USER' | 'ADMIN';
  /** Null/undefined on a non-ADMIN, or an unrestricted (unscoped) ADMIN. */
  staffRoleId?: string | null;
  /** Empty when staffRoleId is null — an unscoped ADMIN bypasses permission
   *  checks entirely rather than being granted an empty set. */
  permissions?: string[];
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    return request.user as AuthenticatedUser;
  },
);
