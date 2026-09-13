import { HostsService } from './hosts.service';

describe('HostsService validation', () => {
  const service = new HostsService(
    {} as never,
    { emitToUser: jest.fn() } as never,
    { notifyUser: jest.fn() } as never,
  );

  it('rejects client-set BUSY availability', async () => {
    await expect(service.setAvailability('user-1', 'BUSY')).rejects.toMatchObject(
      { code: 'VALIDATION_FAILED' },
    );
  });
});
