import { Test } from '@nestjs/testing';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { prisma, resetDatabase } from './helpers';
import { AuthService } from '../src/modules/auth/auth.service';
import { AppModule } from '../src/app.module';
import { INestApplication } from '@nestjs/common';

describe('wallet concurrency', () => {
  let app: INestApplication;
  let wallet: WalletService;
  let auth: AuthService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    wallet = app.get(WalletService);
    auth = app.get(AuthService);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('never overdraws under parallel debits', async () => {
    await auth.register('wallet@example.com', 'ChangeMe123!', 'Wallet');
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'wallet@example.com' },
    });
    await wallet.applyLedger({
      userId: user.id,
      type: 'CREDIT',
      reason: 'PROMOTIONAL_CREDIT',
      amountCents: 100,
      idempotencyKey: 'credit-100',
    });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        wallet.applyLedger({
          userId: user.id,
          type: 'DEBIT',
          reason: 'ADMIN_ADJUSTMENT',
          amountCents: 10,
          idempotencyKey: `debit-${i}`,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(fulfilled).toBe(10);
    expect(rejected).toBe(10);

    const w = await prisma.wallet.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(w.availableBalanceCents).toBe(0);
    expect(w.heldBalanceCents).toBe(0);
  });

  it('credits once when the same idempotency key is used in parallel', async () => {
    await auth.register('dup@example.com', 'ChangeMe123!', 'Dup');
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'dup@example.com' },
    });
    await Promise.all(
      Array.from({ length: 8 }, () =>
        wallet.applyLedger({
          userId: user.id,
          type: 'CREDIT',
          reason: 'PROMOTIONAL_CREDIT',
          amountCents: 250,
          idempotencyKey: 'same-key',
        }),
      ),
    );
    const w = await prisma.wallet.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(w.availableBalanceCents).toBe(250);
    const entries = await prisma.walletLedgerEntry.count({
      where: { wallet: { userId: user.id } },
    });
    expect(entries).toBe(1);
  });
});
