export type ActivityEvent =
  'login' | 'heartbeat' | 'profile_edit' | 'host_online' | 'request' | 'logout';

const MOVES_LAST_ACTIVE = new Set<ActivityEvent>([
  'login',
  'heartbeat',
  'profile_edit',
  'host_online',
]);

/** Ordinary API traffic and logout do not move lastActiveAt. */
export function nextLastActiveAt(
  current: Date,
  event: ActivityEvent,
  now: Date,
): Date {
  return MOVES_LAST_ACTIVE.has(event) ? now : current;
}
