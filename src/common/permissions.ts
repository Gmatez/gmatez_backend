/**
 * Fixed vocabulary of permission keys a StaffRole's `permissions` array may
 * draw from. Roles are dynamic (admins create/edit them); this catalog is
 * not — every @RequirePermission(...) check is validated against this list
 * at startup (see assertKnownPermission), so a typo in a decorator call
 * fails loudly instead of silently granting or denying nothing.
 */
export const PERMISSIONS = [
  'staff.manage',
  'hosts.manage',
  'payouts.manage',
  'payments.view',
  'reports.manage',
  'banners.manage',
  'users.manage',
  'pricing.manage',
  'calls.view',
  'audit.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function assertKnownPermission(
  permission: string,
): asserts permission is Permission {
  if (!(PERMISSIONS as readonly string[]).includes(permission)) {
    throw new Error(
      `Unknown permission "${permission}" — add it to PERMISSIONS in src/common/permissions.ts first.`,
    );
  }
}
