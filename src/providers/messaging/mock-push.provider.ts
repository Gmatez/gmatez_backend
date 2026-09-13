import { Injectable, Logger } from '@nestjs/common';
import { PushMessage, PushProvider } from './push-provider';

@Injectable()
export class MockPushProvider implements PushProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockPushProvider.name);
  readonly sent: Array<{ tokens: string[]; message: PushMessage }> = [];

  async send(
    tokens: string[],
    message: PushMessage,
  ): Promise<{ successCount: number; failedTokens: string[] }> {
    this.sent.push({ tokens, message });
    this.logger.log(
      { tokenCount: tokens.length, title: message.title },
      'mock push',
    );
    return { successCount: tokens.length, failedTokens: [] };
  }
}
