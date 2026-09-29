import { AdminService } from './admin.service';
import { ErrorCodes } from '../../common/errors/app-error';

function harness() {
  const prisma = {
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    platformPricing: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const wallet = {
    ensureForUser: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    applyLedger: jest.fn(),
  };
  const notifications = { notifyUser: jest.fn() };
  const service = new AdminService(
    prisma as never,
    wallet as never,
    {} as never,
    {} as never,
    {} as never,
    notifications as never,
  );
  return { service, prisma, wallet, notifications };
}

describe('admin wallet credit', () => {
  it('credits through the ledger and writes an audit row', async () => {
    const { service, wallet, prisma } = harness();
    wallet.applyLedger.mockResolvedValue({
      duplicate: false,
      wallet: { availableBalanceCents: 500 },
    });
    const result = await service.adjustWallet(
      'admin-1',
      'user-1',
      500,
      'goodwill',
      'key-1',
    );
    expect(wallet.ensureForUser).toHaveBeenCalledWith('user-1');
    expect(wallet.applyLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        type: 'CREDIT',
        reason: 'ADMIN_ADJUSTMENT',
        amountCents: 500,
        idempotencyKey: 'admin-adjust:admin-1:key-1',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(result.duplicate).toBe(false);
  });

  it('rejects a zero amount before touching the wallet', async () => {
    const { service, wallet } = harness();
    await expect(
      service.adjustWallet('admin-1', 'user-1', 0, 'nope'),
    ).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_FAILED,
    });
    expect(wallet.ensureForUser).not.toHaveBeenCalled();
  });

  it('does not write a ledger row when the user has no wallet and cannot be created', async () => {
    const { service, wallet } = harness();
    wallet.ensureForUser.mockRejectedValue(
      Object.assign(new Error('User not found'), { code: 'NOT_FOUND' }),
    );
    await expect(
      service.adjustWallet('admin-1', 'missing', 100, 'gift', 'k'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(wallet.applyLedger).not.toHaveBeenCalled();
  });

  it('does not audit a repeated idempotent credit', async () => {
    const { service, wallet, prisma } = harness();
    wallet.applyLedger.mockResolvedValue({
      duplicate: true,
      wallet: { availableBalanceCents: 500 },
    });
    const result = await service.adjustWallet(
      'admin-1',
      'user-1',
      500,
      'goodwill',
      'key-1',
    );
    expect(result.duplicate).toBe(true);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not audit when the ledger write fails', async () => {
    const { service, wallet, prisma } = harness();
    wallet.applyLedger.mockRejectedValue(new Error('db down'));
    await expect(
      service.adjustWallet('admin-1', 'user-1', 100, 'gift', 'k'),
    ).rejects.toThrow('db down');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('admin notifications', () => {
  const previous = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  afterEach(() => {
    if (previous == null) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = previous;
  });

  it('rejects an invalid type before delivery', async () => {
    const { service, notifications } = harness();
    await expect(
      service.sendNotification('admin-1', {
        userId: 'user-1',
        title: 'Hi',
        body: 'There',
        type: 'Bad Type',
        idempotencyKey: 'n1',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });

  it('requires a user when the audience is a single account', async () => {
    const { service } = harness();
    await expect(
      service.sendNotification('admin-1', {
        audience: 'USER',
        title: 'Hi',
        body: 'There',
        idempotencyKey: 'n2',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
  });

  it('reports CONFIG_REQUIRED when Firebase is not configured', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const { service, prisma, notifications } = harness();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      status: 'ACTIVE',
    });
    notifications.notifyUser.mockResolvedValue({ id: 'note-1' });
    const result = await service.sendNotification('admin-1', {
      userId: 'user-1',
      title: 'Hi',
      body: 'There',
      idempotencyKey: 'n3',
    });
    expect(result.delivery).toBe('CONFIG_REQUIRED');
  });

  it('targets active hosts and skips a repeated broadcast', async () => {
    const { service, prisma, notifications } = harness();
    prisma.user.findMany.mockResolvedValue([{ id: 'host-1' }]);
    notifications.notifyUser.mockResolvedValue({ id: 'note-2' });
    await service.sendNotification('admin-1', {
      audience: 'ALL_HOSTS',
      title: 'Hi',
      body: 'There',
      idempotencyKey: 'n4',
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'ACTIVE', hostProfile: { status: 'ACTIVE' } },
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({ id: 'already' });
    notifications.notifyUser.mockClear();
    const repeat = await service.sendNotification('admin-1', {
      audience: 'ALL_HOSTS',
      title: 'Hi',
      body: 'There',
      idempotencyKey: 'n4',
    });
    expect(repeat.duplicate).toBe(true);
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });
});

describe('admin pricing update', () => {
  it('stores the split and audits the previous value', async () => {
    const { service, prisma } = harness();
    prisma.platformPricing.findUnique.mockResolvedValue({
      userRatePerMinuteCents: 700,
      hostEarningPerMinuteCents: 400,
      hostShareBps: 5714,
    });
    prisma.platformPricing.upsert.mockResolvedValue({
      userRatePerMinuteCents: 1000,
      hostEarningPerMinuteCents: 600,
      hostShareBps: 6000,
    });
    const next = await service.setPricing('admin-1', 1000, 600);
    expect(next.platformPerMinuteCents).toBe(400);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'pricing.update',
          metadata: expect.objectContaining({
            old: expect.objectContaining({ userRatePerMinuteCents: 700 }),
            new: expect.objectContaining({ userRatePerMinuteCents: 1000 }),
          }),
        }),
      }),
    );
  });

  it('rejects an unauthorized-looking invalid rate before writing', async () => {
    const { service, prisma } = harness();
    await expect(service.setPricing('admin-1', 700, 900)).rejects.toMatchObject(
      {
        code: ErrorCodes.VALIDATION_FAILED,
      },
    );
    expect(prisma.platformPricing.upsert).not.toHaveBeenCalled();
  });
});
