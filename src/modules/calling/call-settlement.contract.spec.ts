import { CallStatus } from '@prisma/client';
import { CallingService } from './calling.service';

describe('call settlement contract', () => {
  const service = Object.create(CallingService.prototype) as CallingService;

  it('ENDED without connectedAt is NOT_APPLICABLE (not SETTLED)', () => {
    expect(
      service.settlementStatusFor({
        status: CallStatus.ENDED,
        connectedAt: null,
      } as never),
    ).toBe('NOT_APPLICABLE');
  });

  it('ENDED after CONNECTED is SETTLED', () => {
    expect(
      service.settlementStatusFor({
        status: CallStatus.ENDED,
        connectedAt: new Date(),
      } as never),
    ).toBe('SETTLED');
  });

  it('in-progress statuses are PENDING', () => {
    expect(
      service.settlementStatusFor({
        status: CallStatus.RINGING,
        connectedAt: null,
      } as never),
    ).toBe('PENDING');
    expect(
      service.settlementStatusFor({
        status: CallStatus.CONNECTED,
        connectedAt: new Date(),
      } as never),
    ).toBe('PENDING');
  });

  it('reject/cancel/timeout/fail are NOT_APPLICABLE', () => {
    for (const status of [
      CallStatus.REJECTED,
      CallStatus.CANCELLED,
      CallStatus.TIMEOUT,
      CallStatus.FAILED,
    ]) {
      expect(
        service.settlementStatusFor({ status, connectedAt: null } as never),
      ).toBe('NOT_APPLICABLE');
    }
  });
});
