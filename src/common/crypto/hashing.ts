import {
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function verifyHmacHeader(
  secret: string,
  payload: string,
  signature: string | undefined,
): boolean {
  if (!signature) {
    return false;
  }
  const expected = hmacSha256(secret, payload);
  return timingSafeEqualHex(expected, signature);
}
