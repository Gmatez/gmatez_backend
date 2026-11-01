import { PayoutsService } from './payouts.service';

const notificationsStub = { notifyUser: jest.fn().mockResolvedValue(null) };

describe('PayoutsService eligibility', () => {
  it('rejects amounts below the minimum before debiting', async () => {
    const service = new PayoutsService(
      {} as never,
      {} as never,
      {} as never,
      notificationsStub as never,
    );
    await expect(
      service.request('user-1', 100, 'idempotency-key'),
    ).rejects.toMatchObject({ code: 'PAYOUT_NOT_ELIGIBLE' });
  });

  it('refuses COMPLETED without a provider transfer reference', async () => {
    const prisma = {
      payoutRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          status: 'REQUESTED',
          hostId: 'host-1',
          amountCents: 500,
        }),
      },
    };
    const service = new PayoutsService(
      prisma as never,
      {} as never,
      {} as never,
      notificationsStub as never,
    );
    await expect(
      service.adminSetStatus('admin-1', 'p1', 'COMPLETED'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('allows COMPLETED when a provider transfer reference is given', async () => {
    const prisma = {
      payoutRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          status: 'REQUESTED',
          hostId: 'host-1',
          amountCents: 500,
        }),
        update: jest.fn().mockResolvedValue({ id: 'p1', status: 'COMPLETED' }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new PayoutsService(
      prisma as never,
      {} as never,
      {} as never,
      notificationsStub as never,
    );
    await expect(
      service.adminSetStatus('admin-1', 'p1', 'COMPLETED', undefined, 'utr-123'),
    ).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(prisma.payoutRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerTransferId: 'utr-123',
          externalTransferStatus: 'MANUALLY_CONFIRMED',
        }),
      }),
    );
  });
});
