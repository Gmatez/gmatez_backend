import { loadConfig } from './app-config';

const baseEnv = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  PAYMENT_WEBHOOK_SECRET: 'c'.repeat(16),
  CALLING_WEBHOOK_SECRET: 'd'.repeat(16),
  OTP_PEPPER: 'e'.repeat(16),
};

const smsEnv = {
  OTP_PROVIDER: 'sms' as const,
  SMS_PROVIDER: 'msg91' as const,
  MSG91_AUTH_KEY: 'test-auth-key',
  MSG91_TEMPLATE_ID: 'test-template-id',
};

describe('loadConfig production safety', () => {
  it('allows development with mock defaults', () => {
    const cfg = loadConfig({
      ...baseEnv,
      NODE_ENV: 'development',
    });
    expect(cfg.OTP_PROVIDER).toBe('mock');
    expect(cfg.CALLING_PROVIDER).toBe('mock');
    expect(cfg.PAYMENT_PROVIDER).toBe('mock');
    expect(cfg.PUSH_PROVIDER).toBe('mock');
  });

  it('allows test with mock defaults', () => {
    const cfg = loadConfig({
      ...baseEnv,
      NODE_ENV: 'test',
    });
    expect(cfg.CALLING_PROVIDER).toBe('mock');
  });

  it('rejects production + mock OTP', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        OTP_PROVIDER: 'mock',
        CALLING_PROVIDER: 'agora',
        PAYMENT_PROVIDER: 'stripe',
        PUSH_PROVIDER: 'fcm',
        AGORA_APP_ID: 'app',
        AGORA_APP_CERTIFICATE: 'cert',
        STRIPE_SECRET_KEY: 'sk_live_x',
        FIREBASE_SERVICE_ACCOUNT_JSON: '{}',
      }),
    ).toThrow(/OTP_PROVIDER=mock/);
  });

  it('rejects production sms without credentials', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        OTP_PROVIDER: 'sms',
        CALLING_PROVIDER: 'agora',
        PAYMENT_PROVIDER: 'stripe',
        PUSH_PROVIDER: 'fcm',
        AGORA_APP_ID: 'app',
        AGORA_APP_CERTIFICATE: 'cert',
        STRIPE_SECRET_KEY: 'sk_live_x',
        FIREBASE_SERVICE_ACCOUNT_JSON: '{}',
      }),
    ).toThrow(/SMS_PROVIDER/);
  });

  it('rejects production + mock calling', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        ...smsEnv,
        NODE_ENV: 'production',
        CALLING_PROVIDER: 'mock',
        PAYMENT_PROVIDER: 'stripe',
        PUSH_PROVIDER: 'fcm',
        STRIPE_SECRET_KEY: 'sk_live_x',
        FIREBASE_SERVICE_ACCOUNT_JSON: '{}',
      }),
    ).toThrow(/CALLING_PROVIDER=mock/);
  });

  it('rejects production + mock payment', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        ...smsEnv,
        NODE_ENV: 'production',
        CALLING_PROVIDER: 'agora',
        PAYMENT_PROVIDER: 'mock',
        PUSH_PROVIDER: 'fcm',
        AGORA_APP_ID: 'app',
        AGORA_APP_CERTIFICATE: 'cert',
        FIREBASE_SERVICE_ACCOUNT_JSON: '{}',
      }),
    ).toThrow(/PAYMENT_PROVIDER=mock/);
  });

  it('rejects production + mock push', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        ...smsEnv,
        NODE_ENV: 'production',
        CALLING_PROVIDER: 'agora',
        PAYMENT_PROVIDER: 'stripe',
        PUSH_PROVIDER: 'mock',
        AGORA_APP_ID: 'app',
        AGORA_APP_CERTIFICATE: 'cert',
        STRIPE_SECRET_KEY: 'sk_live_x',
      }),
    ).toThrow(/PUSH_PROVIDER=mock/);
  });

  it('rejects production + ALLOW_MOCK_PROVIDERS bypass', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        ...smsEnv,
        NODE_ENV: 'production',
        ALLOW_MOCK_PROVIDERS: 'true',
        CALLING_PROVIDER: 'agora',
        PAYMENT_PROVIDER: 'stripe',
        PUSH_PROVIDER: 'fcm',
        AGORA_APP_ID: 'app',
        AGORA_APP_CERTIFICATE: 'cert',
        STRIPE_SECRET_KEY: 'sk_live_x',
        FIREBASE_SERVICE_ACCOUNT_JSON: '{}',
      }),
    ).toThrow(/ALLOW_MOCK_PROVIDERS cannot be true/);
  });

  it('rejects production when providers are omitted', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
      }),
    ).toThrow(/must be set explicitly/);
  });

  it('accepts production with real providers and secrets', () => {
    const cfg = loadConfig({
      ...baseEnv,
      ...smsEnv,
      NODE_ENV: 'production',
      CALLING_PROVIDER: 'agora',
      PAYMENT_PROVIDER: 'stripe',
      PUSH_PROVIDER: 'fcm',
      AGORA_APP_ID: 'app',
      AGORA_APP_CERTIFICATE: 'cert',
      STRIPE_SECRET_KEY: 'sk_live_x',
      FIREBASE_SERVICE_ACCOUNT_JSON: '{}',
    });
    expect(cfg.CALLING_PROVIDER).toBe('agora');
    expect(cfg.OTP_PROVIDER).toBe('sms');
  });

  it('allows staging mocks only with explicit ALLOW_MOCK_PROVIDERS', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'staging',
        OTP_PROVIDER: 'mock',
        CALLING_PROVIDER: 'mock',
        PAYMENT_PROVIDER: 'mock',
        PUSH_PROVIDER: 'mock',
      }),
    ).toThrow(/ALLOW_MOCK_PROVIDERS=true/);

    const cfg = loadConfig({
      ...baseEnv,
      NODE_ENV: 'staging',
      ALLOW_MOCK_PROVIDERS: 'true',
      OTP_PROVIDER: 'mock',
      CALLING_PROVIDER: 'mock',
      PAYMENT_PROVIDER: 'mock',
      PUSH_PROVIDER: 'mock',
    });
    expect(cfg.PAYMENT_PROVIDER).toBe('mock');
  });
});
