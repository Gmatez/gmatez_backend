import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).default(43121),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  CALLING_PROVIDER: z.enum(['mock', 'agora']).default('mock'),
  PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
  PUSH_PROVIDER: z.enum(['mock', 'fcm']).default('mock'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16),
  CALLING_WEBHOOK_SECRET: z.string().min(16),
  OTP_PEPPER: z.string().min(16),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:43121'),
  // Demo hosts only. Real production must leave this unset.
  ALLOW_MOCK_PROVIDERS: z.enum(['true', 'false']).optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional().default(''),
  STRIPE_SECRET_KEY: z.string().optional().default(''),
  AGORA_APP_ID: z.string().optional().default(''),
  AGORA_APP_CERTIFICATE: z.string().optional().default(''),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.ALLOW_MOCK_PROVIDERS !== 'true') {
    if (
      cfg.CALLING_PROVIDER === 'mock' ||
      cfg.PAYMENT_PROVIDER === 'mock' ||
      cfg.PUSH_PROVIDER === 'mock'
    ) {
      throw new Error('Mock providers are not allowed in production');
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

  get allowsMockSandbox(): boolean {
    return (
      !this.isProduction || this.get('ALLOW_MOCK_PROVIDERS') === 'true'
    );
  }
}
