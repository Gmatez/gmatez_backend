export const PHONE_IDENTITY_VERIFIER = Symbol('PHONE_IDENTITY_VERIFIER');

export type VerifiedPhoneIdentity = {
  phoneE164: string;
};

/**
 * Verifies that a caller has proven ownership of a phone number out-of-band
 * (e.g. Firebase Phone Auth on the client) and hands back the verified
 * E.164 number. AuthService owns what happens next (find-or-create user,
 * issue session) — this interface only proves phone ownership.
 */
export interface PhoneIdentityVerifier {
  readonly name: string;
  verify(idToken: string): Promise<VerifiedPhoneIdentity>;
}
