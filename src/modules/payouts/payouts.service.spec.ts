import { PayoutsService } from './payouts.service';

describe('PayoutsService eligibility', () => {
  it('rejects amounts below the minimum before debiting', async () => {
    const service = new PayoutsService({} as never, {} as never, {} as never);
    await expect(
      service.request('user-1', 100, 'idempotency-key'),
    ).rejects.toMatchObject({ code: 'PAYOUT_NOT_ELIGIBLE' });
  });

  it('refuses COMPLETED because no external transfer exists', async () => {
    const prisma = {
      payoutRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          status: 'REQUESTED',
          userId: 'host-1',
          amountCents: 500,
        }),
      },
    };
    const service = new PayoutsService(
      prisma as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.adminSetStatus('admin-1', 'p1', 'COMPLETED'),
    ).rejects.toMatchObject({ code: 'PAYOUT_NOT_ELIGIBLE' });
  });
});
