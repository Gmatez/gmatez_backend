import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config';
import { CALLING_PROVIDER } from './calling/calling.tokens';
import type { CallingProvider } from './calling/calling-provider';
import { MockCallingProvider } from './calling/mock-calling.provider';
import { AgoraCallingProvider } from './calling/agora-calling.provider';
import { PAYMENT_PROVIDER } from './payments/payment.tokens';
import type { PaymentProvider } from './payments/payment-provider';
import { MockPaymentProvider } from './payments/mock-payment.provider';
import { StripePaymentProvider } from './payments/stripe-payment.provider';
import { PUSH_PROVIDER } from './messaging/push.tokens';
import type { PushProvider } from './messaging/push-provider';
import { MockPushProvider } from './messaging/mock-push.provider';
import { FcmPushProvider } from './messaging/fcm-push.provider';

@Global()
@Module({
  providers: [
    MockCallingProvider,
    AgoraCallingProvider,
    MockPaymentProvider,
    StripePaymentProvider,
    MockPushProvider,
    FcmPushProvider,
    {
      provide: CALLING_PROVIDER,
      useFactory: (
        config: AppConfigService,
        mock: MockCallingProvider,
        agora: AgoraCallingProvider,
      ): CallingProvider =>
        config.get('CALLING_PROVIDER') === 'agora' ? agora : mock,
      inject: [AppConfigService, MockCallingProvider, AgoraCallingProvider],
    },
    {
      provide: PAYMENT_PROVIDER,
      useFactory: (
        config: AppConfigService,
        mock: MockPaymentProvider,
        stripe: StripePaymentProvider,
      ): PaymentProvider =>
        config.get('PAYMENT_PROVIDER') === 'stripe' ? stripe : mock,
      inject: [AppConfigService, MockPaymentProvider, StripePaymentProvider],
    },
    {
      provide: PUSH_PROVIDER,
      useFactory: (
        config: AppConfigService,
        mock: MockPushProvider,
        fcm: FcmPushProvider,
      ): PushProvider => (config.get('PUSH_PROVIDER') === 'fcm' ? fcm : mock),
      inject: [AppConfigService, MockPushProvider, FcmPushProvider],
    },
  ],
  exports: [
    CALLING_PROVIDER,
    PAYMENT_PROVIDER,
    PUSH_PROVIDER,
    MockCallingProvider,
    MockPaymentProvider,
  ],
})
export class ProvidersModule {}
