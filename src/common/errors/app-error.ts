import { HttpStatus } from '@nestjs/common';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const ErrorCodes = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  USER_SUSPENDED: 'USER_SUSPENDED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  OTP_INVALID: 'OTP_INVALID',
  WALLET_INSUFFICIENT_FUNDS: 'WALLET_INSUFFICIENT_FUNDS',
  PAYMENT_WEBHOOK_INVALID: 'PAYMENT_WEBHOOK_INVALID',
  CALL_INVALID_TRANSITION: 'CALL_INVALID_TRANSITION',
  CALL_NOT_PARTICIPANT: 'CALL_NOT_PARTICIPANT',
  CALL_ALREADY_ACTIVE: 'CALL_ALREADY_ACTIVE',
  USER_BLOCKED: 'USER_BLOCKED',
  USER_BUSY: 'USER_BUSY',
  HOST_OFFLINE: 'HOST_OFFLINE',
  HOST_BUSY: 'HOST_BUSY',
  HOST_NOT_APPROVED: 'HOST_NOT_APPROVED',
  PAYOUT_NOT_ELIGIBLE: 'PAYOUT_NOT_ELIGIBLE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
