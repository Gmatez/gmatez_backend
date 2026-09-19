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
import {
  OTP_DELIVERY_PROVIDER,
  type OtpDeliveryProvider,
} from './otp/otp-delivery-provider';
import { MockOtpDeliveryProvider } from './otp/mock-otp.provider';
import { Msg91OtpDeliveryProvider } from './otp/msg91-otp.provider';
import { TwilioOtpDeliveryProvider } from './otp/twilio-otp.provider';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';

@Global()
@Module({
  providers: [
    RateLimitService,
    MockCallingProvider,
    AgoraCallingProvider,
    MockPaymentProvider,
    StripePaymentProvider,
    MockPushProvider,
    FcmPushProvider,
    MockOtpDeliveryProvider,
    Msg91OtpDeliveryProvider,
    TwilioOtpDeliveryProvider,
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
    {
      provide: OTP_DELIVERY_PROVIDER,
      useFactory: (
        config: AppConfigService,
        mock: MockOtpDeliveryProvider,
        msg91: Msg91OtpDeliveryProvider,
        twilio: TwilioOtpDeliveryProvider,
      ): OtpDeliveryProvider => {
        if (config.get('OTP_PROVIDER') !== 'sms') {
          return mock;
        }
        return config.get('SMS_PROVIDER') === 'twilio' ? twilio : msg91;
      },
      inject: [
        AppConfigService,
        MockOtpDeliveryProvider,
        Msg91OtpDeliveryProvider,
        TwilioOtpDeliveryProvider,
      ],
    },
  ],
  exports: [
    RateLimitService,
    CALLING_PROVIDER,
    PAYMENT_PROVIDER,
    PUSH_PROVIDER,
    OTP_DELIVERY_PROVIDER,
    MockCallingProvider,
    MockPaymentProvider,
  ],
})
export class ProvidersModule {}
