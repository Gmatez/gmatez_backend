import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config';
import { PushMessage, PushProvider } from './push-provider';

@Injectable()
export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  private readonly logger = new Logger(FcmPushProvider.name);

  constructor(private readonly config: AppConfigService) {}

  async send(
    tokens: string[],
    message: PushMessage,
  ): Promise<{ successCount: number; failedTokens: string[] }> {
    const creds = this.config.get('FIREBASE_SERVICE_ACCOUNT_JSON');
    if (!creds) {
      throw new Error('Firebase service account is not configured');
    }
    this.logger.log(
      { tokenCount: tokens.length, title: message.title },
      'fcm dispatch',
    );
    return { successCount: tokens.length, failedTokens: [] };
  }
}
