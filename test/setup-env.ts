import { config as loadDotenv } from 'dotenv';

loadDotenv({ quiet: true });

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL?.replace(
    /\/[^/?]+(\?|$)/,
    '/social_calling_test$1',
  ) ||
  'postgresql://ubuntu:postgres@127.0.0.1:5432/social_calling_test?schema=public';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'test-access-secret-change-me-32chars';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-change-me-32ch';
process.env.PAYMENT_WEBHOOK_SECRET =
  process.env.PAYMENT_WEBHOOK_SECRET || 'test-payment-webhook-secret';
process.env.CALLING_WEBHOOK_SECRET =
  process.env.CALLING_WEBHOOK_SECRET || 'test-calling-webhook-secret';
process.env.OTP_PEPPER =
  process.env.OTP_PEPPER || 'test-otp-pepper-change-me-32chars';
process.env.OTP_PROVIDER = 'mock';
process.env.MOCK_OTP = '123456';
process.env.CALLING_PROVIDER = 'mock';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.PUSH_PROVIDER = 'mock';
process.env.PORT = process.env.PORT || '43121';
