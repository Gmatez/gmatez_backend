import { normalizePhoneE164 } from './phone.util';

describe('normalizePhoneE164', () => {
  it('normalizes Indian formats to E.164', () => {
    expect(normalizePhoneE164('+919876543210')).toBe('+919876543210');
    expect(normalizePhoneE164('919876543210')).toBe('+919876543210');
    expect(normalizePhoneE164('09876543210')).toBe('+919876543210');
    expect(normalizePhoneE164('9876543210')).toBe('+919876543210');
  });

  it('supports US when configured', () => {
    expect(normalizePhoneE164('+12025550123', 'IN,US,GB', 'US')).toBe(
      '+12025550123',
    );
    expect(normalizePhoneE164('2025550123', 'IN,US,GB', 'US')).toBe(
      '+12025550123',
    );
  });

  it('rejects unsupported country', () => {
    expect(() => normalizePhoneE164('+33123456789', 'IN,US,GB')).toThrow(
      /not supported/,
    );
  });
});
