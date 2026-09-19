import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import type {
  OtpDeliveryProvider,
  SendOtpInput,
} from './otp-delivery-provider';

/**
 * Twilio Programmable Messaging SMS delivery.
 * CONFIG_REQUIRED: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 */
@Injectable()
export class TwilioOtpDeliveryProvider implements OtpDeliveryProvider {
  readonly name = 'twilio';
  private readonly logger = new Logger(TwilioOtpDeliveryProvider.name);

  constructor(private readonly config: AppConfigService) {}

  async sendOtp(input: SendOtpInput): Promise<void> {
    const sid = this.config.get('TWILIO_ACCOUNT_SID');
    const token = this.config.get('TWILIO_AUTH_TOKEN');
    const from = this.config.get('TWILIO_FROM_NUMBER');
    if (!sid || !token || !from) {
      throw new AppError(
        ErrorCodes.OTP_DELIVERY_FAILED,
        'SMS provider is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const body = new URLSearchParams({
      To: input.phoneE164,
      From: from,
      Body: `Your Gmatez verification code is ${input.otp}`,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization:
            'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
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
