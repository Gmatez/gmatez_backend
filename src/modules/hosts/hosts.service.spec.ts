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
    {} as never,
  );

  it('rejects a listener application when identity documents are missing', async () => {
    const documents = {
      requireApplicationDocuments: jest.fn().mockRejectedValue(
        Object.assign(new Error('missing'), {
          code: 'HOST_APPLICATION_INVALID',
        }),
      ),
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1',
          status: 'ACTIVE',
          profile: { ratePerMinuteCents: 100 },
          hostProfile: null,
        }),
      },
      $transaction: jest.fn(),
    };
    const applicant = new HostsService(
      prisma as never,
      { emitToUser: jest.fn() } as never,
      { notifyUser: jest.fn() } as never,
      completeness,
      documents as never,
    );
    await expect(
      applicant.apply('user-1', {
        applicationBio: 'I host evening conversations',
        languages: ['en'],
        interests: ['music'],
        acceptedAgreements: [
          { agreementType: 'HOST_GUIDELINES', version: '1.0' },
          { agreementType: 'TERMS_OF_SERVICE', version: '1.0' },
          { agreementType: 'PRIVACY_POLICY', version: '1.0' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'HOST_APPLICATION_INVALID' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects client-set BUSY availability', async () => {
    await expect(
      service.setAvailability('user-1', 'BUSY'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
