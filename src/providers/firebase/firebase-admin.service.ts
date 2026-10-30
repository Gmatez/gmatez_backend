import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config';

type AdminAuth = {
  verifyIdToken: (idToken: string) => Promise<Record<string, unknown>>;
};

type AdminApp = object;

/**
 * Shared firebase-admin app initialization for all Firebase-backed providers
 * (FCM push, Firebase phone-auth token verification, ...).
 * CONFIG_REQUIRED: FIREBASE_SERVICE_ACCOUNT_JSON must be valid service-account JSON.
 *
 * firebase-admin v12+ dropped the legacy `admin.apps`/`admin.credential.cert`/
 * `admin.auth()` namespace from the root `require('firebase-admin')` export —
 * initialization and per-service accessors now live on modular subpaths
 * (`firebase-admin/app`, `firebase-admin/auth`).
 */
@Injectable()
export class FirebaseAdminService {
  private readonly logger = new Logger(FirebaseAdminService.name);
  private app: AdminApp | null = null;

  constructor(private readonly config: AppConfigService) {
    const creds = this.config.get('FIREBASE_SERVICE_ACCOUNT_JSON');
    if (!creds) {
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const appModule = require('firebase-admin/app') as {
        initializeApp: (opts: { credential: unknown }) => AdminApp;
        cert: (json: unknown) => unknown;
        getApps: () => AdminApp[];
      };
      const { initializeApp, cert, getApps } = appModule;
      const existing = getApps();
      if (existing.length) {
        this.app = existing[0];
      } else {
        const json = JSON.parse(normalizeServiceAccount(creds)) as Record<
          string,
          unknown
        >;
        this.app = initializeApp({ credential: cert(json) });
      }
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : 'unknown' },
        'firebase_admin.init_failed',
      );
    }
  }

  getAuth(): AdminAuth {
    if (!this.app) {
      throw new Error(
        'Firebase Admin is not configured (FIREBASE_SERVICE_ACCOUNT_JSON). CONFIG_REQUIRED.',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAuth } = require('firebase-admin/auth') as {
      getAuth: (app: AdminApp) => AdminAuth;
    };
    return getAuth(this.app);
  }
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
