import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import type {
  OtpDeliveryProvider,
  SendOtpInput,
} from './otp-delivery-provider';

/**
 * MSG91 OTP API (India-first). Requires DLT-approved template in production India.
 * Docs: https://docs.msg91.com/
 *
 * CONFIG_REQUIRED: MSG91_AUTH_KEY, MSG91_TEMPLATE_ID, optional MSG91_SENDER_ID
 */
@Injectable()
export class Msg91OtpDeliveryProvider implements OtpDeliveryProvider {
  readonly name = 'msg91';
  private readonly logger = new Logger(Msg91OtpDeliveryProvider.name);

  constructor(private readonly config: AppConfigService) {}

  async sendOtp(input: SendOtpInput): Promise<void> {
    const authKey = this.config.get('MSG91_AUTH_KEY');
    const templateId = this.config.get('MSG91_TEMPLATE_ID');
    if (!authKey || !templateId) {
      throw new AppError(
        ErrorCodes.OTP_DELIVERY_FAILED,
        'SMS provider is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const mobile = input.phoneE164.replace(/^\+/, '');
    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.searchParams.set('template_id', templateId);
    url.searchParams.set('mobile', mobile);
    url.searchParams.set('otp', input.otp);
    url.searchParams.set('otp_length', String(input.otp.length));
    const sender = this.config.get('MSG91_SENDER_ID');
    if (sender) {
      url.searchParams.set('sender', sender);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authkey: authKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(
          {
            phone: maskPhone(input.phoneE164),
            status: response.status,
            provider: this.name,
          },
          'otp.delivery_failed',
        );
        throw new AppError(
          ErrorCodes.OTP_DELIVERY_FAILED,
          'Unable to send verification code. Please try again.',
          HttpStatus.BAD_GATEWAY,
        );
      }
      this.logger.log(
        { phone: maskPhone(input.phoneE164), provider: this.name },
        'otp.delivered',
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      this.logger.warn(
        {
          phone: maskPhone(input.phoneE164),
          provider: this.name,
          err: error instanceof Error ? error.message : 'unknown',
        },
        'otp.delivery_failed',
      );
      throw new AppError(
        ErrorCodes.OTP_DELIVERY_FAILED,
        'Unable to send verification code. Please try again.',
        HttpStatus.BAD_GATEWAY,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function maskPhone(phone: string): string {
  if (phone.length < 6) return '******';
  return `${phone.slice(0, 3)}******${phone.slice(-2)}`;
}
