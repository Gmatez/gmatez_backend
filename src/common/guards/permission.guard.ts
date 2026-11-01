import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError, ErrorCodes } from '../errors/app-error';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { AuthenticatedUser } from '../decorators/current-user.decorator';
import { Permission } from '../permissions';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<Permission>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!permission) {
      return true;
    }
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new AppError(ErrorCodes.FORBIDDEN, 'Insufficient permissions', 403);
    }
    // An ADMIN with no staffRoleId is unrestricted — today's behavior,
    // unchanged. Permission scoping only narrows an ADMIN that has
    // explicitly been assigned a StaffRole.
    if (user.role === 'ADMIN' && !user.staffRoleId) {
      return true;
    }
    if (!user.permissions?.includes(permission)) {
      throw new AppError(ErrorCodes.FORBIDDEN, 'Insufficient permissions', 403);
    }
    return true;
  }
}
