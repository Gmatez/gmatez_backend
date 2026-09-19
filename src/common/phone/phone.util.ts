import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorCodes } from '../errors/app-error';

const DEFAULT_REGION = 'IN';

/** Digits-only national length expectations for supported regions. */
const REGION_RULES: Record<string, { dial: string; nationalLength: number }> = {
  IN: { dial: '91', nationalLength: 10 },
  US: { dial: '1', nationalLength: 10 },
  GB: { dial: '44', nationalLength: 10 },
};

/**
 * Canonical E.164 normalization shared by auth, OTP, and tests.
 * Supported regions come from config (comma-separated ISO codes), default IN,US,GB.
 */
export function normalizePhoneE164(
  input: string,
  supportedRegionsCsv = 'IN,US,GB',
  defaultRegion = DEFAULT_REGION,
): string {
  const supported = supportedRegionsCsv
    .split(',')
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);
  const compact = input.replace(/[\s()-]/g, '');
  let digits = compact.startsWith('+')
    ? compact.slice(1).replace(/\D/g, '')
    : compact.replace(/\D/g, '');

  if (digits.startsWith('0') && digits.length === 11) {
    digits = digits.slice(1);
  }

  let e164 = '';
  if (compact.startsWith('+') && digits.length >= 8) {
    e164 = `+${digits}`;
  } else {
    const region = supported.includes(defaultRegion)
      ? defaultRegion
      : (supported[0] ?? DEFAULT_REGION);
    const rule = REGION_RULES[region] ?? REGION_RULES[DEFAULT_REGION];
    if (digits.length === rule.nationalLength) {
      e164 = `+${rule.dial}${digits}`;
    } else if (
      digits.startsWith(rule.dial) &&
      digits.length === rule.dial.length + rule.nationalLength
    ) {
      e164 = `+${digits}`;
    }
  }

  if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
    throw new AppError(
      ErrorCodes.VALIDATION_FAILED,
      'Enter a valid phone number',
      HttpStatus.BAD_REQUEST,
    );
  }

  // Enforce supported country dial prefixes when possible
  const allowed = supported
    .map((code) => REGION_RULES[code]?.dial)
    .filter(Boolean);
  if (allowed.length > 0) {
    const ok = allowed.some((dial) => e164.startsWith(`+${dial}`));
    if (!ok) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Phone country is not supported',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  return e164;
}

export function maskPhone(phone: string): string {
  if (phone.length < 6) return '******';
  return `${phone.slice(0, 3)}******${phone.slice(-2)}`;
}
