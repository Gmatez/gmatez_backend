import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const environments = ['development', 'test', 'staging', 'production'] as const;

const schema = z.object({
  NODE_ENV: z.enum(environments).default('development'),
  PORT: z.coerce.number().int().min(1).default(43121),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  OTP_PROVIDER: z.enum(['mock', 'sms']).optional(),
  SMS_PROVIDER: z.enum(['msg91', 'twilio']).optional(),
  CALLING_PROVIDER: z.enum(['mock', 'agora']).optional(),
  PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).optional(),
  PUSH_PROVIDER: z.enum(['mock', 'fcm']).optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16),
  CALLING_WEBHOOK_SECRET: z.string().min(16),
  OTP_PEPPER: z.string().min(16),
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce
    .number()
    .int()
    .min(10)
    .max(600)
    .default(60),
  OTP_MAX_SENDS_PER_WINDOW: z.coerce.number().int().min(1).max(50).default(5),
  OTP_SEND_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(3600),
  OTP_MAX_SENDS_PER_IP_WINDOW: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(20),
  OTP_MAX_VERIFY_PER_WINDOW: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10),
  OTP_VERIFY_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(3600),
  SUPPORTED_PHONE_REGIONS: z.string().default('IN,US,GB'),
  DEFAULT_PHONE_REGION: z.string().default('IN'),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:43121'),
  ALLOW_MOCK_PROVIDERS: z.enum(['true', 'false']).optional(),
  MOCK_OTP: z.string().optional(),
  MSG91_AUTH_KEY: z.string().optional().default(''),
  MSG91_TEMPLATE_ID: z.string().optional().default(''),
  MSG91_SENDER_ID: z.string().optional().default(''),
  TWILIO_ACCOUNT_SID: z.string().optional().default(''),
  TWILIO_AUTH_TOKEN: z.string().optional().default(''),
  TWILIO_FROM_NUMBER: z.string().optional().default(''),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional().default(''),
  STRIPE_SECRET_KEY: z.string().optional().default(''),
  AGORA_APP_ID: z.string().optional().default(''),
  AGORA_APP_CERTIFICATE: z.string().optional().default(''),
  /** Short-lived RTC token TTL (seconds). Default 1 hour; renew before expiry. */
  AGORA_TOKEN_EXPIRY_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(3600),
  /** Host share of call charge in basis points. Default 8000 = 80%. BUSINESS_RULE_REQUIRED. */
  CREATOR_SHARE_BPS: z.coerce.number().int().min(0).max(10_000).default(8000),
});

export type AppConfig = z.infer<typeof schema> & {
  OTP_PROVIDER: 'mock' | 'sms';
  CALLING_PROVIDER: 'mock' | 'agora';
  PAYMENT_PROVIDER: 'mock' | 'stripe';
  PUSH_PROVIDER: 'mock' | 'fcm';
};

function isLocalEnv(env: (typeof environments)[number]): boolean {
  return env === 'development' || env === 'test';
}

function resolveProvider<T extends string>(
  value: T | undefined,
  fallback: T,
  env: (typeof environments)[number],
  name: string,
): T {
  if (value) {
    return value;
  }
  if (isLocalEnv(env)) {
    return fallback;
  }
  throw new Error(
    `Invalid configuration: ${name} must be set explicitly for NODE_ENV=${env}`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  const raw = parsed.data;
  const nodeEnv = raw.NODE_ENV;

  if (nodeEnv === 'production' && raw.ALLOW_MOCK_PROVIDERS === 'true') {
    throw new Error(
      'Invalid configuration: ALLOW_MOCK_PROVIDERS cannot be true when NODE_ENV=production',
    );
  }

  const cfg: AppConfig = {
    ...raw,
    OTP_PROVIDER: resolveProvider(
      raw.OTP_PROVIDER,
      'mock',
      nodeEnv,
      'OTP_PROVIDER',
    ),
    CALLING_PROVIDER: resolveProvider(
      raw.CALLING_PROVIDER,
      'mock',
      nodeEnv,
      'CALLING_PROVIDER',
    ),
    PAYMENT_PROVIDER: resolveProvider(
      raw.PAYMENT_PROVIDER,
      'mock',
      nodeEnv,
      'PAYMENT_PROVIDER',
    ),
    PUSH_PROVIDER: resolveProvider(
      raw.PUSH_PROVIDER,
      'mock',
      nodeEnv,
      'PUSH_PROVIDER',
    ),
  };

  const mocks: Array<[string, string]> = [];
  if (cfg.OTP_PROVIDER === 'mock') mocks.push(['OTP_PROVIDER', 'mock']);
  if (cfg.CALLING_PROVIDER === 'mock') mocks.push(['CALLING_PROVIDER', 'mock']);
  if (cfg.PAYMENT_PROVIDER === 'mock') mocks.push(['PAYMENT_PROVIDER', 'mock']);
  if (cfg.PUSH_PROVIDER === 'mock') mocks.push(['PUSH_PROVIDER', 'mock']);

  if (nodeEnv === 'production' && mocks.length > 0) {
    throw new Error(
      `Invalid configuration: mock providers are forbidden in production (${mocks
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')})`,
    );
  }

  if (nodeEnv === 'staging' && mocks.length > 0) {
    if (raw.ALLOW_MOCK_PROVIDERS !== 'true') {
      throw new Error(
        `Invalid configuration: staging uses mock providers (${mocks
          .map(([k, v]) => `${k}=${v}`)
          .join(
            ', ',
          )}). Set real providers, or set ALLOW_MOCK_PROVIDERS=true only for explicit staging sandbox.`,
      );
    }
  }

  if (cfg.OTP_PROVIDER === 'sms') {
    const smsProvider = cfg.SMS_PROVIDER;
    if (!smsProvider) {
      throw new Error(
        'Invalid configuration: OTP_PROVIDER=sms requires SMS_PROVIDER=msg91|twilio',
      );
    }
    if (smsProvider === 'msg91') {
      if (!cfg.MSG91_AUTH_KEY || !cfg.MSG91_TEMPLATE_ID) {
        throw new Error(
          'Invalid configuration: SMS_PROVIDER=msg91 requires MSG91_AUTH_KEY and MSG91_TEMPLATE_ID',
        );
      }
    }
    if (smsProvider === 'twilio') {
      if (
        !cfg.TWILIO_ACCOUNT_SID ||
        !cfg.TWILIO_AUTH_TOKEN ||
        !cfg.TWILIO_FROM_NUMBER
      ) {
        throw new Error(
          'Invalid configuration: SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER',
        );
      }
    }
  }

  if (cfg.CALLING_PROVIDER === 'agora') {
    if (!cfg.AGORA_APP_ID || !cfg.AGORA_APP_CERTIFICATE) {
      throw new Error(
        'Invalid configuration: CALLING_PROVIDER=agora requires AGORA_APP_ID and AGORA_APP_CERTIFICATE',
      );
    }
  }

  if (cfg.PAYMENT_PROVIDER === 'stripe' && nodeEnv === 'production') {
    if (!cfg.STRIPE_SECRET_KEY) {
      throw new Error(
        'Invalid configuration: PAYMENT_PROVIDER=stripe requires STRIPE_SECRET_KEY in production',
      );
    }
  }

  if (cfg.PUSH_PROVIDER === 'fcm' && nodeEnv === 'production') {
    if (!cfg.FIREBASE_SERVICE_ACCOUNT_JSON) {
      throw new Error(
        'Invalid configuration: PUSH_PROVIDER=fcm requires FIREBASE_SERVICE_ACCOUNT_JSON in production',
      );
    }
  }

  return cfg;
}

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get isStaging(): boolean {
    return this.get('NODE_ENV') === 'staging';
  }

  get isLocal(): boolean {
    const env = this.get('NODE_ENV');
    return env === 'development' || env === 'test';
  }

  get allowsMockProviders(): boolean {
    if (this.isProduction) {
      return false;
    }
    if (this.isLocal) {
      return true;
    }
    return this.get('ALLOW_MOCK_PROVIDERS') === 'true';
  }

  get allowsMockSandbox(): boolean {
    return this.allowsMockProviders && this.get('PAYMENT_PROVIDER') === 'mock';
  }
}
