import { CallStatus } from '@prisma/client';
import { canTransition, isTerminal } from './call-state.machine';

describe('CallStateMachine', () => {
  it('allows the happy-path path', () => {
    expect(canTransition(CallStatus.INITIATED, CallStatus.RINGING)).toBe(true);
    expect(canTransition(CallStatus.RINGING, CallStatus.ACCEPTED)).toBe(true);
    expect(canTransition(CallStatus.ACCEPTED, CallStatus.CONNECTING)).toBe(
      true,
    );
    expect(canTransition(CallStatus.CONNECTING, CallStatus.CONNECTED)).toBe(
      true,
    );
    expect(canTransition(CallStatus.CONNECTED, CallStatus.ENDED)).toBe(true);
  });

  it('rejects illegal jumps', () => {
    expect(canTransition(CallStatus.INITIATED, CallStatus.CONNECTED)).toBe(
      false,
    );
    expect(canTransition(CallStatus.ENDED, CallStatus.CONNECTED)).toBe(false);
    expect(canTransition(CallStatus.REJECTED, CallStatus.ACCEPTED)).toBe(false);
  });

  it('marks terminal statuses', () => {
    expect(isTerminal(CallStatus.ENDED)).toBe(true);
    expect(isTerminal(CallStatus.CONNECTED)).toBe(false);
  });
});
