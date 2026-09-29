import { WalletService } from './wallet.service';
import { ErrorCodes } from '../../common/errors/app-error';

describe('wallet ensureForUser', () => {
  it('creates a wallet when the account has none', async () => {
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'user-1', status: 'ACTIVE' }),
      },
      wallet: {
        upsert: jest
          .fn()
          .mockResolvedValue({ userId: 'user-1', currency: 'USD' }),
      },
    };
    const service = new WalletService(prisma as never);
    await service.ensureForUser('user-1');
    expect(prisma.wallet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        create: { userId: 'user-1', currency: 'USD' },
      }),
    );
  });

  it('refuses a missing or deleted account', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      wallet: { upsert: jest.fn() },
    };
    const service = new WalletService(prisma as never);
    await expect(service.ensureForUser('gone')).rejects.toMatchObject({
      code: ErrorCodes.NOT_FOUND,
    });
    expect(prisma.wallet.upsert).not.toHaveBeenCalled();
  });
});
