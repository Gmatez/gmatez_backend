import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
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
    sendEachForMulticast: (msg: Record<string, unknown>) => Promise<{
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
      // firebase-admin v12+ moved init + per-service accessors off the root
      // namespace onto modular subpaths (`firebase-admin/app`,
      // `firebase-admin/messaging`) — `admin.apps`/`admin.messaging()` no
      // longer exist on `require('firebase-admin')`.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initializeApp, cert, getApps } = require('firebase-admin/app') as {
        initializeApp: (opts: { credential: unknown }) => unknown;
        cert: (json: unknown) => unknown;
        getApps: () => unknown[];
      };
      let app = getApps()[0];
      if (!app) {
        const json = JSON.parse(normalizeServiceAccount(creds)) as Record<
          string,
          unknown
        >;
        app = initializeApp({ credential: cert(json) });
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getMessaging } = require('firebase-admin/messaging') as {
        getMessaging: (app: unknown) => typeof this.messaging;
      };
      this.messaging = getMessaging(app) as typeof this.messaging;
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
      throw new AppError(
        ErrorCodes.INTERNAL,
        'FCM is not configured (FIREBASE_SERVICE_ACCOUNT_JSON). CONFIG_REQUIRED.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const result = await this.messaging.sendEachForMulticast(
      this.toFcmMessage(tokens, message),
    );
    const failedTokens: string[] = [];
    result.responses.forEach((response, index) => {
      if (!response.success) {
        failedTokens.push(tokens[index]);
        this.logger.warn(
          { code: response.error?.code ?? 'unknown' },
          'fcm.token_failed',
        );
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

  /**
   * A closed app does not run Dart, so Android must draw the call alert
   * itself. The data block still opens the call when the host taps it.
   *
   * Deliberately NO top-level `notification` key here: with one present,
   * Android renders a plain system-tray banner straight from the OS
   * whenever the app is backgrounded/killed, and the app's own
   * onMessageReceived handler (which is what actually draws the
   * full-screen incoming-call UI) is not guaranteed to run first. A
   * data-only message guarantees the handler runs. Safe for iOS too: the
   * explicit apns.payload.aps.alert below defines its own alert
   * independent of this field.
   */
  private toFcmMessage(tokens: string[], message: PushMessage) {
    const data = stringifyData(message.data ?? {});
    const incomingCall = data.type === 'incoming_call';
    if (incomingCall) {
      return {
        tokens,
        data: {
          ...data,
          title: data.title || message.title,
          body: data.body || message.body,
        },
        android: {
          priority: 'high' as const,
          ttl: 45_000,
          notification: {
            channelId: 'gmatez_incoming_call',
            sound: 'incoming_call',
            priority: 'max' as const,
            visibility: 'public' as const,
            defaultSound: false,
            defaultVibrateTimings: true,
          },
        },
        apns: {
          headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
          payload: {
            aps: {
              alert: { title: message.title, body: message.body },
              sound: 'incoming_call.wav',
            },
          },
        },
      };
    }
    return {
      tokens,
      notification: { title: message.title, body: message.body },
      data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'general',
          icon: 'ic_stat_notify',
          sound: 'default',
        },
      },
    };
  }
}

function stringifyData(data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value == null) {
      continue;
    }
    out[key] = String(value);
  }
  return out;
}

function normalizeServiceAccount(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"') && !value.startsWith('{"'))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}
