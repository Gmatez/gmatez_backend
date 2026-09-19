import { ChatService } from './chat.service';

describe('ChatService send validation', () => {
  const service = new ChatService(
    {} as never,
    {} as never,
    { emitToUser: jest.fn(), emitToConversation: jest.fn() } as never,
    {
      assertAllowed: jest.fn().mockResolvedValue(undefined),
    } as never,
    {} as never,
    {} as never,
  );

  it('rejects empty bodies before persistence', async () => {
    await expect(
      service.sendMessage('user-1', 'conv-1', '   ', 'idempotency-key'),
    ).rejects.toMatchObject({ code: 'MESSAGE_INVALID' });
  });

  it('rejects oversized bodies', async () => {
    await expect(
      service.sendMessage(
        'user-1',
        'conv-1',
        'x'.repeat(2001),
        'idempotency-key',
      ),
    ).rejects.toMatchObject({ code: 'MESSAGE_TOO_LONG' });
  });
});
