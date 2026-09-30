import { assessCapture } from './payment-integrity';

const payment = {
  providerPaymentId: 'order_test_1',
  amountCents: 50000,
  currency: 'INR',
};

describe('payment capture integrity', () => {
  it('accepts a matching INR capture', () => {
    expect(
      assessCapture(payment, {
        orderId: 'order_test_1',
        amountPaise: 50000,
        currency: 'INR',
      }).ok,
    ).toBe(true);
  });

  it('rejects an amount mismatch', () => {
    expect(
      assessCapture(payment, {
        orderId: 'order_test_1',
        amountPaise: 100,
        currency: 'INR',
      }),
    ).toEqual({ ok: false, code: 'AMOUNT_MISMATCH' });
  });

  it('rejects a currency mismatch', () => {
    expect(
      assessCapture(payment, {
        orderId: 'order_test_1',
        amountPaise: 50000,
        currency: 'USD',
      }),
    ).toEqual({ ok: false, code: 'CURRENCY_MISMATCH' });
  });

  it('rejects an order mismatch', () => {
    expect(
      assessCapture(payment, {
        orderId: 'order_other',
        amountPaise: 50000,
        currency: 'INR',
      }),
    ).toEqual({ ok: false, code: 'ORDER_MISMATCH' });
  });
});
