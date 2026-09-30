import type { ProviderPaymentSnapshot } from '../../providers/payments/payment-provider';

export type CaptureCheck =
  | { ok: true }
  | {
      ok: false;
      code: 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH' | 'ORDER_MISMATCH';
    };

type ExpectedPayment = {
  providerPaymentId: string;
  amountCents: number;
  currency: string;
};

/**
 * Compare a provider capture with the internal Payment row.
 * Amounts are integer minor units (paise for INR). No floating point.
 */
export function assessCapture(
  payment: ExpectedPayment,
  evidence: {
    orderId: string;
    amountPaise: number;
    currency: string;
  },
): CaptureCheck {
  if (evidence.orderId !== payment.providerPaymentId) {
    return { ok: false, code: 'ORDER_MISMATCH' };
  }
  if (evidence.currency.toUpperCase() !== payment.currency.toUpperCase()) {
    return { ok: false, code: 'CURRENCY_MISMATCH' };
  }
  if (evidence.amountPaise !== payment.amountCents) {
    return { ok: false, code: 'AMOUNT_MISMATCH' };
  }
  return { ok: true };
}

export function snapshotMatchesPayment(
  payment: ExpectedPayment,
  snapshot: ProviderPaymentSnapshot,
): CaptureCheck {
  return assessCapture(payment, {
    orderId: snapshot.orderId,
    amountPaise: snapshot.amountPaise,
    currency: snapshot.currency,
  });
}
