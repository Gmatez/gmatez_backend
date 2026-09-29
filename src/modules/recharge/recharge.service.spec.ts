import { RechargeService } from './recharge.service';
import { ErrorCodes } from '../../common/errors/app-error';

function harness() {
  const prisma = {
    rechargePlan: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  return { service: new RechargeService(prisma as never), prisma };
}

const plan = {
  id: 'plan-1',
  name: 'Standard',
  priceMinor: 25000,
  walletCreditMinor: 27500,
  bonusMinor: 2500,
  isActive: true,
};

describe('recharge plans', () => {
  it('creates a plan and audits it', async () => {
    const { service, prisma } = harness();
    prisma.rechargePlan.create.mockResolvedValue(plan);
    const created = await service.create('admin-1', {
      name: 'Standard',
      priceMinor: 25000,
      walletCreditMinor: 27500,
      bonusMinor: 2500,
    });
    expect(created.name).toBe('Standard');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'recharge_plan.create' }),
      }),
    );
  });

  it('updates an existing plan', async () => {
    const { service, prisma } = harness();
    prisma.rechargePlan.findUnique.mockResolvedValue(plan);
    prisma.rechargePlan.update.mockResolvedValue({ ...plan, name: 'Plus' });
    const updated = await service.update('admin-1', 'plan-1', { name: 'Plus' });
    expect(updated.name).toBe('Plus');
  });

  it('disables a plan', async () => {
    const { service, prisma } = harness();
    prisma.rechargePlan.findUnique.mockResolvedValue(plan);
    prisma.rechargePlan.update.mockResolvedValue({ ...plan, isActive: false });
    const updated = await service.update('admin-1', 'plan-1', {
      isActive: false,
    });
    expect(updated.isActive).toBe(false);
    expect(prisma.rechargePlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isActive: false }),
      }),
    );
  });

  it('enables a plan', async () => {
    const { service, prisma } = harness();
    prisma.rechargePlan.findUnique.mockResolvedValue({
      ...plan,
      isActive: false,
    });
    prisma.rechargePlan.update.mockResolvedValue(plan);
    const updated = await service.update('admin-1', 'plan-1', {
      isActive: true,
    });
    expect(updated.isActive).toBe(true);
  });

  it('deletes a plan', async () => {
    const { service, prisma } = harness();
    prisma.rechargePlan.findUnique.mockResolvedValue(plan);
    await expect(service.remove('admin-1', 'plan-1')).resolves.toEqual({
      id: 'plan-1',
      deleted: true,
    });
    expect(prisma.rechargePlan.delete).toHaveBeenCalledWith({
      where: { id: 'plan-1' },
    });
  });

  it('lists only active plans for the user API', async () => {
    const { service, prisma } = harness();
    prisma.rechargePlan.findMany.mockResolvedValue([plan]);
    await service.listActive();
    expect(prisma.rechargePlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });

  it('rejects a non-positive price', async () => {
    const { service } = harness();
    await expect(
      service.create('admin-1', {
        name: 'Bad',
        priceMinor: 0,
        walletCreditMinor: 100,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
  });
});
