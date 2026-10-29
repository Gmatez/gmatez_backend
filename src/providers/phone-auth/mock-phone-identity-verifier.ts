import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import type {
  PhoneIdentityVerifier,
  VerifiedPhoneIdentity,
} from './phone-identity-verifier';

/**
 * Test-only. Never used outside NODE_ENV=test (config refuses
 * PHONE_AUTH_PROVIDER=mock otherwise). The "token" is the E.164 phone
 * number itself — there is no real Firebase token to verify in tests.
 */
@Injectable()
export class MockPhoneIdentityVerifier implements PhoneIdentityVerifier {
  readonly name = 'mock';
  private readonly logger = new Logger(MockPhoneIdentityVerifier.name);

  async verify(idToken: string): Promise<VerifiedPhoneIdentity> {
    const phoneE164 = idToken.trim();
    if (!phoneE164.startsWith('+')) {
      throw new AppError(
        ErrorCodes.PHONE_TOKEN_INVALID,
        'Invalid or expired phone verification token',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.logger.log({ provider: this.name }, 'phone_identity.verified_mock');
    return { phoneE164 };
  }
}
