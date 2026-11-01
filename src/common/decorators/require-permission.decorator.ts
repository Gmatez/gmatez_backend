import { SetMetadata } from '@nestjs/common';
import { assertKnownPermission, Permission } from '../permissions';

export const PERMISSION_KEY = 'permission';

/**
 * Guards a route behind a single permission from the fixed catalog in
 * src/common/permissions.ts. An ADMIN user with no staffRoleId (today's
 * default, unrestricted admin) always passes — this only narrows access for
 * an ADMIN who has been scoped to a StaffRole. Pair with PermissionGuard.
 */
export const RequirePermission = (permission: Permission) => {
  assertKnownPermission(permission);
  return SetMetadata(PERMISSION_KEY, permission);
};
