import {
  callSettlementWhere,
  classifyProvider,
  maskDestinationDetails,
  maskSecret,
  parseAnalyticsDays,
  parsePageQuery,
} from './admin-query.util';

describe('admin query helpers', () => {
  it('parses page bounds', () => {
    expect(parsePageQuery('2', '10')).toEqual({
      page: 2,
      pageSize: 10,
      skip: 10,
      take: 10,
    });
  });

  it('rejects an oversized page', () => {
    expect(() => parsePageQuery('1', '500')).toThrow(/pageSize/);
  });

  it('caps analytics windows', () => {
    expect(parseAnalyticsDays(undefined)).toBe(14);
    expect(() => parseAnalyticsDays('0')).toThrow(/days/);
    expect(() => parseAnalyticsDays('91')).toThrow(/days/);
  });

  it('masks secrets without keeping the full value', () => {
    expect(maskSecret('abc123456789xyz789', 6, 6)).toBe('abc123…xyz789');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret('1234567890', 0, 4)).toBe('••••7890');
  });

  it('masks payout destination fields and keeps non-secret labels', () => {
    expect(
      maskDestinationDetails({
        type: 'UPI',
        label: 'Primary',
        vpa: 'host@bank',
        accountNumber: '123456789012',
      }),
    ).toEqual({
      type: 'UPI',
      label: 'Primary',
      vpa: '••••bank',
      accountNumber: '••••9012',
    });
  });

  it('does not mark an unprobed live provider as connected', () => {
    expect(
      classifyProvider({ mode: 'live', credentialsPresent: true }),
    ).toEqual({
      status: 'CONFIGURED',
      verification: 'INTEGRATED_NOT_VERIFIED',
    });
    expect(
      classifyProvider({ mode: 'live', credentialsPresent: false }),
    ).toEqual({
      status: 'CONFIG_REQUIRED',
      verification: 'NOT_APPLICABLE',
    });
    expect(
      classifyProvider({ mode: 'mock', credentialsPresent: false }),
    ).toEqual({
      status: 'DISABLED',
      verification: 'NOT_APPLICABLE',
    });
  });

  it('maps settlement filters to the call contract', () => {
    expect(callSettlementWhere('SETTLED')).toEqual({
      status: 'ENDED',
      connectedAt: { not: null },
    });
    expect(callSettlementWhere('PENDING')).toEqual({
      status: {
        notIn: ['REJECTED', 'CANCELLED', 'TIMEOUT', 'FAILED', 'ENDED'],
      },
    });
    expect(callSettlementWhere(undefined)).toBeUndefined();
  });
});
