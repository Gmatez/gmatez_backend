import {
  computeBilledSeconds,
  computeCallCostCents,
  computeCreatorEarningCents,
} from './call-state.machine';

describe('call billing math', () => {
  it('charges a full minute for 1 second', () => {
    expect(computeCallCostCents(120, 1)).toBe(2);
  });

  it('charges exact minutes without extra cent', () => {
    expect(computeCallCostCents(100, 60)).toBe(100);
  });

  it('returns 0 for non-connected duration', () => {
    expect(computeCallCostCents(100, 0)).toBe(0);
  });

  it('uses server timestamps only', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    const end = new Date('2026-01-01T00:01:01.000Z');
    expect(computeBilledSeconds(start, end)).toBe(61);
  });
});

describe('creator earnings math', () => {
  it('credits 80% of the charge to the creator', () => {
    expect(computeCreatorEarningCents(100)).toBe(80);
  });

  it('does not credit when the call was not billed', () => {
    expect(computeCreatorEarningCents(0)).toBe(0);
  });
});
