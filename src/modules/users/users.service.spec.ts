import { UsersService } from './users.service';

function buildPrismaMock() {
  return {
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    deviceToken: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    payoutDestination: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    hostProfile: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    profile: { update: jest.fn().mockResolvedValue({}) },
    user: { update: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };
}

describe('UsersService.deleteMe', () => {
  it('refuses to delete while a call is active', async () => {
    const prisma = buildPrismaMock();
    const calling = {
      findActiveCallForUser: jest.fn().mockResolvedValue({ id: 'call-1' }),
    };
    const hostDocuments = { deleteAll: jest.fn() };
    const service = new UsersService(
      prisma as never,
      {} as never,
      calling as never,
      hostDocuments as never,
    );

    await expect(service.deleteMe('user-1')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(hostDocuments.deleteAll).not.toHaveBeenCalled();
  });

  it('anonymizes PII, revokes sessions, and scrubs on-disk documents', async () => {
    const prisma = buildPrismaMock();
    const calling = {
      findActiveCallForUser: jest.fn().mockResolvedValue(null),
    };
    const hostDocuments = { deleteAll: jest.fn().mockResolvedValue(undefined) };
    const service = new UsersService(
      prisma as never,
      {} as never,
      calling as never,
      hostDocuments as never,
    );

    await service.deleteMe('user-1');

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(prisma.payoutDestination.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { label: '', detailsJson: {} },
    });

    const hostPatch = prisma.hostProfile.updateMany.mock.calls[0][0];
    expect(hostPatch.where).toEqual({ userId: 'user-1' });
    expect(hostPatch.data.identityCardNumber).toBeNull();
    expect(hostPatch.data.idProofLast4).toBeNull();
    expect(hostPatch.data.internalNote).toBeNull();
    expect(hostPatch.data.languages).toEqual([]);

    const profilePatch = prisma.profile.update.mock.calls[0][0];
    expect(profilePatch.data.displayName).toBe('Deleted user');
    expect(profilePatch.data.isDiscoverable).toBe(false);
    expect(profilePatch.data.country).toBeNull();

    const userPatch = prisma.user.update.mock.calls[0][0];
    expect(userPatch.data.status).toBe('DELETED');
    expect(userPatch.data.phone).toBeNull();
    expect(typeof userPatch.data.passwordHash).toBe('string');
    expect(userPatch.data.passwordHash).not.toBe('');

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'user-1',
        action: 'user.self_delete',
        targetType: 'user',
        targetId: 'user-1',
      }),
    });

    expect(hostDocuments.deleteAll).toHaveBeenCalledWith('user-1');
  });

  it('does not fail the deletion if removing on-disk documents errors', async () => {
    const prisma = buildPrismaMock();
    const calling = {
      findActiveCallForUser: jest.fn().mockResolvedValue(null),
    };
    const hostDocuments = {
      deleteAll: jest.fn().mockRejectedValue(new Error('disk unavailable')),
    };
    const service = new UsersService(
      prisma as never,
      {} as never,
      calling as never,
      hostDocuments as never,
    );

    await expect(service.deleteMe('user-1')).resolves.toBeUndefined();
    expect(prisma.user.update).toHaveBeenCalled();
  });
});
