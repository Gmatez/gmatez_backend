import { PayoutsService } from './payouts.service';

describe('PayoutsService eligibility', () => {
  it('rejects amounts below the minimum before debiting', async () => {
    const service = new PayoutsService({} as never, {} as never);
    await expect(
      service.request('user-1', 100, 'idempotency-key'),
    ).rejects.toMatchObject({ code: 'PAYOUT_NOT_ELIGIBLE' });
  });
});
