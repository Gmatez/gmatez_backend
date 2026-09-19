import { HostsService } from './hosts.service';
import { HostCompletenessService } from './host-completeness.service';

describe('HostsService validation', () => {
  const completeness = {
    evaluate: jest.fn().mockResolvedValue({
      isComplete: true,
      percentage: 100,
      missingFields: [],
      verificationStatus: 'NOT_REQUIRED',
      requiredAgreements: [],
    }),
  } as unknown as HostCompletenessService;

  const service = new HostsService(
    {} as never,
    { emitToUser: jest.fn() } as never,
    { notifyUser: jest.fn() } as never,
    completeness,
  );

  it('rejects client-set BUSY availability', async () => {
    await expect(
      service.setAvailability('user-1', 'BUSY'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
