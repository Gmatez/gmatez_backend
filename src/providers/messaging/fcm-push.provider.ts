import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config';
import { PushMessage, PushProvider } from './push-provider';

/**
 * FCM push via firebase-admin when credentials are configured.
 * CONFIG_REQUIRED: FIREBASE_SERVICE_ACCOUNT_JSON must be valid service-account JSON.
 * Does not fake success when credentials are missing.
 */
@Injectable()
export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  private readonly logger = new Logger(FcmPushProvider.name);
  private messaging: {
    sendEachForMulticast: (msg: {
      tokens: string[];
      notification: { title: string; body: string };
      data?: Record<string, string>;
    }) => Promise<{
      successCount: number;
      responses: Array<{ success: boolean; error?: { code?: string } }>;
    }>;
  } | null = null;

  constructor(private readonly config: AppConfigService) {
    const creds = this.config.get('FIREBASE_SERVICE_ACCOUNT_JSON');
    if (!creds) {
      return;
    }
    try {
      // Lazy require so mock environments need not install/init Firebase.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const admin = require('firebase-admin') as {
        apps: unknown[];
        initializeApp: (opts: { credential: unknown }) => void;
        credential: { cert: (json: unknown) => unknown };
        messaging: () => typeof this.messaging;
      };
      if (!admin.apps.length) {
        const json = JSON.parse(creds) as Record<string, unknown>;
        admin.initializeApp({ credential: admin.credential.cert(json) });
      }
      this.messaging = admin.messaging() as typeof this.messaging;
    } catch (error) {
      this.logger.error(
        {
          err: error instanceof Error ? error.message : 'unknown',
        },
        'fcm.init_failed',
      );
    }
  }

  async send(
    tokens: string[],
    message: PushMessage,
  ): Promise<{ successCount: number; failedTokens: string[] }> {
    if (!tokens.length) {
      return { successCount: 0, failedTokens: [] };
    }
    if (!this.messaging) {
      throw new Error(
        'FCM is not configured (FIREBASE_SERVICE_ACCOUNT_JSON). CONFIG_REQUIRED.',
      );
    }
    const result = await this.messaging.sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      data: message.data,
    });
    const failedTokens: string[] = [];
    result.responses.forEach((response, index) => {
      if (!response.success) {
        failedTokens.push(tokens[index]);
      }
    });
    this.logger.log(
      {
        tokenCount: tokens.length,
        successCount: result.successCount,
        failedCount: failedTokens.length,
      },
      'fcm.dispatch',
    );
    return { successCount: result.successCount, failedTokens };
  }
}
