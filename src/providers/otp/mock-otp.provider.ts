import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config';
import type {
  OtpDeliveryProvider,
  SendOtpInput,
} from './otp-delivery-provider';

/**
 * Local/test delivery. Never used in production (config refuses OTP_PROVIDER=mock).
 * Does not log the OTP value.
 */
@Injectable()
export class MockOtpDeliveryProvider implements OtpDeliveryProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockOtpDeliveryProvider.name);

  constructor(private readonly config: AppConfigService) {}

  async sendOtp(input: SendOtpInput): Promise<void> {
    this.logger.log(
      { phone: maskPhone(input.phoneE164), provider: this.name },
      'otp.delivery_mock',
    );
    // Expose for automated tests via Redis is unnecessary — AuthService uses MOCK_OTP.
    void this.config;
  }
}

function maskPhone(phone: string): string {
  if (phone.length < 6) return '******';
  return `${phone.slice(0, 3)}******${phone.slice(-2)}`;
}
