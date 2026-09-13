import { ChatService } from './chat.service';

describe('ChatService send validation', () => {
  it('rejects empty bodies before persistence', async () => {
    const service = new ChatService(
      {} as never,
      {} as never,
      { emitToUser: jest.fn() } as never,
    );
    await expect(
      service.sendMessage('user-1', 'conv-1', '   ', 'idempotency-key'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
