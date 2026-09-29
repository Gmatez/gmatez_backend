import { shareBpsForSettlement, splitMinuteRate } from './pricing';

describe('minute pricing', () => {
  it('splits a 700 minor user rate and 400 minor host earning', () => {
    const split = splitMinuteRate(700, 400);
    expect(split.platformPerMinuteCents).toBe(300);
    expect(split.hostShareBps).toBe(5714);
  });

  it('recalculates the platform amount when either side changes', () => {
    expect(splitMinuteRate(1000, 600).platformPerMinuteCents).toBe(400);
  });

  it('rejects a host earning above the user rate', () => {
    expect(() => splitMinuteRate(700, 800)).toThrow(/Host earning/);
  });

  it('keeps a historical call on the share snapshotted at start', () => {
    const liveBps = 8000;
    expect(shareBpsForSettlement(5714, liveBps)).toBe(5714);
    expect(shareBpsForSettlement(null, liveBps)).toBe(liveBps);
  });
});
