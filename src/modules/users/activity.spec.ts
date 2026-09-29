import { nextLastActiveAt } from './activity';

describe('last active', () => {
  const current = new Date('2026-09-28T10:00:00.000Z');
  const now = new Date('2026-09-29T12:05:00.000Z');

  it('moves the timestamp on login and heartbeat', () => {
    expect(nextLastActiveAt(current, 'login', now).toISOString()).toBe(
      now.toISOString(),
    );
    expect(nextLastActiveAt(current, 'heartbeat', now).toISOString()).toBe(
      now.toISOString(),
    );
  });

  it('keeps the previous timestamp when the user is only making API requests or logging out', () => {
    expect(nextLastActiveAt(current, 'request', now)).toEqual(current);
    expect(nextLastActiveAt(current, 'logout', now)).toEqual(current);
  });

  it('stores an absolute UTC instant rather than a local wall-clock string', () => {
    const next = nextLastActiveAt(current, 'heartbeat', now);
    expect(next.toISOString()).toBe('2026-09-29T12:05:00.000Z');
  });
});
