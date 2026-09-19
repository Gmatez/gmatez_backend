/**
 * External identity/KYC verification provider abstraction.
 * No live provider is wired in Phase 3 — status remains CONFIG_REQUIRED.
 */
export type HostKycSubmitInput = {
  userId: string;
  /** Opaque provider payload reference — never store raw ID documents here. */
  externalReference?: string;
};

export interface HostKycProvider {
  readonly name: string;
  submit(input: HostKycSubmitInput): Promise<{ providerRef: string }>;
}

export class StubHostKycProvider implements HostKycProvider {
  readonly name = 'stub';

  async submit(_input: HostKycSubmitInput): Promise<{ providerRef: string }> {
    throw new Error(
      'External KYC provider is not configured (CONFIG_REQUIRED)',
    );
  }
}
