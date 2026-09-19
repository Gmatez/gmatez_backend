export const OTP_DELIVERY_PROVIDER = Symbol('OTP_DELIVERY_PROVIDER');

export type SendOtpInput = {
  phoneE164: string;
  otp: string;
};

/**
 * Delivery-only. AuthService owns generation, hashing, expiry, and attempts.
 */
export interface OtpDeliveryProvider {
  readonly name: string;
  sendOtp(input: SendOtpInput): Promise<void>;
}
