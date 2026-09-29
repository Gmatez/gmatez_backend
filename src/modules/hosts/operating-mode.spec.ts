import {
  assertSingleOperatingMode,
  operatingModeForHostStatus,
} from './operating-mode';

describe('operating mode', () => {
  it('keeps a normal account as USER when there is no active host profile', () => {
    expect(operatingModeForHostStatus(null)).toBe('USER');
    expect(operatingModeForHostStatus('PENDING_REVIEW')).toBe('USER');
    expect(assertSingleOperatingMode('USER')).toBe('USER');
  });

  it('operates as HOST only while the host profile is ACTIVE', () => {
    expect(operatingModeForHostStatus('ACTIVE')).toBe('HOST');
    expect(assertSingleOperatingMode('HOST')).toBe('HOST');
  });

  it('switches USER to HOST when the host profile is approved', () => {
    expect(operatingModeForHostStatus('PENDING_REVIEW')).toBe('USER');
    expect(operatingModeForHostStatus('ACTIVE')).toBe('HOST');
  });

  it('switches HOST back to USER when the host profile leaves ACTIVE', () => {
    expect(operatingModeForHostStatus('ACTIVE')).toBe('HOST');
    expect(operatingModeForHostStatus('SUSPENDED')).toBe('USER');
    expect(operatingModeForHostStatus('REJECTED')).toBe('USER');
  });

  it('cannot represent user and host as active operating modes together', () => {
    const mode = operatingModeForHostStatus('ACTIVE');
    expect(mode).toBe('HOST');
    expect(mode).not.toBe('USER');
    expect(['USER', 'HOST']).toContain(mode);
    expect(['USER', 'HOST'].filter((item) => item === mode)).toHaveLength(1);
  });
});
