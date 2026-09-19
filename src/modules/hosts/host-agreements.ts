/**
 * Current mandatory host agreement versions.
 * Bump a version when legal text changes — hosts must re-accept that type.
 */
export const HOST_AGREEMENT_VERSIONS = {
  HOST_GUIDELINES: '1.0',
  TERMS_OF_SERVICE: '1.0',
  PRIVACY_POLICY: '1.0',
} as const;

export type HostAgreementType = keyof typeof HOST_AGREEMENT_VERSIONS;

export const REQUIRED_HOST_AGREEMENTS = Object.entries(
  HOST_AGREEMENT_VERSIONS,
).map(([agreementType, version]) => ({
  agreementType: agreementType as HostAgreementType,
  version,
}));
