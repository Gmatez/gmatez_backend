import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { FirebaseAdminService } from '../firebase/firebase-admin.service';
import type {
  PhoneIdentityVerifier,
  VerifiedPhoneIdentity,
} from './phone-identity-verifier';

/**
 * Verifies a Firebase Phone-Auth ID token minted client-side by the Flutter
 * app's own firebase_auth SDK call. Firebase owns sending/checking the SMS
 * code; this only proves the resulting token is genuine and carries a
 * verified phone number.
 */
@Injectable()
export class FirebasePhoneIdentityVerifier implements PhoneIdentityVerifier {
  readonly name = 'firebase';
  private readonly logger = new Logger(FirebasePhoneIdentityVerifier.name);

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  async verify(idToken: string): Promise<VerifiedPhoneIdentity> {
    let decoded: Record<string, unknown>;
    try {
      decoded = await this.firebaseAdmin.getAuth().verifyIdToken(idToken);
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : 'unknown' },
        'phone_identity.verify_failed',
      );
      throw new AppError(
        ErrorCodes.PHONE_TOKEN_INVALID,
        'Invalid or expired phone verification token',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const phoneE164 = decoded.phone_number;
    const signInProvider = (
      decoded.firebase as { sign_in_provider?: string } | undefined
    )?.sign_in_provider;
    if (typeof phoneE164 !== 'string' || !phoneE164) {
      throw new AppError(
        ErrorCodes.PHONE_TOKEN_INVALID,
        'Invalid or expired phone verification token',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (signInProvider && signInProvider !== 'phone') {
      throw new AppError(
        ErrorCodes.PHONE_TOKEN_INVALID,
        'Invalid or expired phone verification token',
        HttpStatus.UNAUTHORIZED,
      );
    }

    this.logger.log({ provider: this.name }, 'phone_identity.verified');
    return { phoneE164 };
  }
}
