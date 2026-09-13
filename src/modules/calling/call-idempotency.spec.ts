import { CallStatus } from '@prisma/client';
import { canTransition } from './call-state.machine';

describe('duplicate call actions', () => {
  it('treats already-accepted as a no-op candidate', () => {
    expect(canTransition(CallStatus.ACCEPTED, CallStatus.ACCEPTED)).toBe(false);
  });
});
