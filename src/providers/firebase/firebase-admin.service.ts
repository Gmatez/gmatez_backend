import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config';

type AdminAuth = {
  verifyIdToken: (idToken: string) => Promise<Record<string, unknown>>;
};

type AdminModule = {
  apps: unknown[];
  initializeApp: (opts: { credential: unknown }) => void;
  credential: { cert: (json: unknown) => unknown };
  auth: () => AdminAuth;
};

/**
 * Shared firebase-admin app initialization for all Firebase-backed providers
 * (FCM push, Firebase phone-auth token verification, ...).
 * CONFIG_REQUIRED: FIREBASE_SERVICE_ACCOUNT_JSON must be valid service-account JSON.
 */
@Injectable()
export class FirebaseAdminService {
  private readonly logger = new Logger(FirebaseAdminService.name);
  private admin: AdminModule | null = null;

  constructor(private readonly config: AppConfigService) {
    const creds = this.config.get('FIREBASE_SERVICE_ACCOUNT_JSON');
    if (!creds) {
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const admin = require('firebase-admin') as AdminModule;
      if (!admin.apps.length) {
        const json = JSON.parse(normalizeServiceAccount(creds)) as Record<
          string,
          unknown
        >;
        admin.initializeApp({ credential: admin.credential.cert(json) });
      }
      this.admin = admin;
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : 'unknown' },
        'firebase_admin.init_failed',
      );
    }
  }

  getAuth(): AdminAuth {
    if (!this.admin) {
      throw new Error(
        'Firebase Admin is not configured (FIREBASE_SERVICE_ACCOUNT_JSON). CONFIG_REQUIRED.',
      );
    }
    return this.admin.auth();
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
