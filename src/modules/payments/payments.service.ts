import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Payment, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PAYMENT_PROVIDER } from '../../providers/payments/payment.tokens';
import type { PaymentProvider } from '../../providers/payments/payment-provider';
import { RazorpayPaymentProvider } from '../../providers/payments/razorpay-payment.provider';
import { AppConfigService } from '../../config/app-config';
import { hmacSha256, sha256 } from '../../common/crypto/hashing';
import { WalletService } from '../wallet/wallet.service';
import { assessCapture } from './payment-integrity';

type CaptureInput = {
  orderId: string;
  paymentId: string;
  amountPaise: number;
  currency: string;
  eventId: string;
  eventType: string;
  rawBody?: string;
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly config: AppConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async createIntent(
    userId: string,
    amountCents: number | undefined,
    idempotencyKey: string,
    rechargePlanId?: string,
  ) {
    const priced = await this.resolvePlanCharge(amountCents, rechargePlanId);
    const currency = this.provider.name === 'razorpay' ? 'INR' : 'USD';
    if (priced.amountCents < 100) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Minimum top-up is 100 minor units',
      );
    }
    const existing = await this.prisma.payment.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      if (existing.userId !== userId) {
        throw new AppError(
          ErrorCodes.FORBIDDEN,
          'Idempotency key already used',
          HttpStatus.CONFLICT,
        );
      }
      return this.present(existing);
    }

    await this.wallet.ensureForUser(userId);
    const intent = await this.provider.createIntent({
      amountCents: priced.amountCents,
      currency,
      userId,
      idempotencyKey,
    });

    try {
      const payment = await this.prisma.payment.create({
        data: {
          userId,
          amountCents: priced.amountCents,
          creditCents: priced.creditCents,
          rechargePlanId: priced.rechargePlanId,
          currency,
          status:
            this.provider.name === 'razorpay' ? 'REQUIRES_ACTION' : 'PENDING',
          provider: this.provider.name,
          providerPaymentId: intent.providerPaymentId,
          idempotencyKey,
          clientSecret:
            this.provider.name === 'razorpay' ? null : intent.clientSecret,
          reconciliationStatus: 'PENDING',
        },
      });
      this.logger.log({
        event: 'payment_created',
        paymentId: payment.id,
        userId,
        amountCents: payment.amountCents,
        currency: payment.currency,
        provider: payment.provider,
        orderId: payment.providerPaymentId,
      });
      if (payment.provider === 'razorpay') {
        this.logger.log({
          event: 'payment_checkout_started',
          paymentId: payment.id,
          orderId: payment.providerPaymentId,
        });
      }
      return this.present(payment);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const payment = await this.prisma.payment.findUnique({
          where: { idempotencyKey },
        });
        if (payment) {
          return this.present(payment);
        }
      }
      throw error;
    }
  }

  /**
   * TEST/DEV ONLY. Credits wallet via the same webhook path as production providers.
   * Never available when NODE_ENV=production (allowsMockProviders is always false).
   */
  async sandboxConfirm(userId: string, paymentId: string) {
    if (
      this.config.isProduction ||
      !this.config.allowsMockProviders ||
      this.provider.name !== 'mock'
    ) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const payment = await this.getOwn(userId, paymentId);
    if (payment.status === 'SUCCEEDED') {
      return { duplicate: true, paymentId: payment.id, status: payment.status };
    }
    const payload = JSON.stringify({
      eventId: `sandbox_${payment.id}_${Date.now()}`,
      providerPaymentId: payment.providerPaymentId,
      status: 'succeeded',
      amountCents: payment.amountCents,
      currency: payment.currency,
    });
    const signature = hmacSha256(
      this.config.get('PAYMENT_WEBHOOK_SECRET'),
      payload,
    );
    return this.handleWebhook(payload, signature);
  }

  async getOwn(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment || payment.userId !== userId) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Payment not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return payment;
  }

  async getOwnView(userId: string, paymentId: string) {
    return this.present(await this.getOwn(userId, paymentId));
  }

  /**
   * Flutter checkout result. Signature + live Razorpay payment fetch.
   * A success callback alone does not credit the wallet.
   */
  async verifyCheckout(
    userId: string,
    paymentId: string,
    input: { orderId: string; paymentId: string; signature: string },
  ) {
    const razorpay = this.requireRazorpay();
    const payment = await this.getOwn(userId, paymentId);
    if (payment.provider !== 'razorpay') {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Payment is not a Razorpay order',
      );
    }
    if (input.orderId !== payment.providerPaymentId) {
      await this.flag(payment.id, 'ORDER_MISMATCH', input.paymentId);
      throw new AppError(
        ErrorCodes.CONFLICT,
        'Payment does not match the Razorpay order',
        HttpStatus.CONFLICT,
      );
    }
    if (
      !razorpay.verifyCheckoutSignature({
        orderId: input.orderId,
        paymentId: input.paymentId,
        signature: input.signature,
      })
    ) {
      throw new AppError(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Invalid payment signature',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.logger.log({
      event: 'payment_verified',
      paymentId: payment.id,
      orderId: input.orderId,
      providerPaymentId: input.paymentId,
    });
    const remote = await razorpay.fetchPayment(input.paymentId);
    if (remote.status === 'failed') {
      await this.markFailed(
        payment.id,
        remote.errorDescription ?? 'payment_failed',
      );
      return {
        credited: false,
        duplicate: false,
        status: 'FAILED',
        paymentId: payment.id,
      };
    }
    if (remote.status !== 'captured') {
      return {
        credited: false,
        duplicate: false,
        status: payment.status,
        paymentId: payment.id,
      };
    }
    return this.creditCapturedPayment({
      orderId: remote.orderId,
      paymentId: remote.id,
      amountPaise: remote.amountPaise,
      currency: remote.currency,
      eventId: `checkout:${remote.id}`,
      eventType: 'razorpay.checkout.verified',
    });
  }

  /**
   * User closed checkout. Does not invent success. If Razorpay already captured
   * the payment, the wallet is credited through the same path as the webhook.
   */
  async abandon(userId: string, paymentId: string) {
    const payment = await this.getOwn(userId, paymentId);
    if (payment.status === 'SUCCEEDED') {
      return this.present(payment);
    }
    if (payment.status === 'FAILED' || payment.status === 'CANCELLED') {
      return this.present(payment);
    }
    const razorpay = this.razorpay();
    if (razorpay && payment.provider === 'razorpay') {
      try {
        const order = await razorpay.fetchOrder(payment.providerPaymentId);
        if (order.status === 'paid') {
          const captured = (
            await razorpay.fetchOrderPayments(payment.providerPaymentId)
          ).find((item) => item.status === 'captured');
          if (captured) {
            await this.creditCapturedPayment({
              orderId: captured.orderId,
              paymentId: captured.id,
              amountPaise: captured.amountPaise,
              currency: captured.currency,
              eventId: `abandon-recover:${captured.id}`,
              eventType: 'razorpay.abandon.recovered',
            });
            return this.present(
              await this.prisma.payment.findUniqueOrThrow({
                where: { id: payment.id },
              }),
            );
          }
        }
      } catch (error) {
        this.logger.warn({
          event: 'payment_reconciliation_required',
          paymentId: payment.id,
          reason: 'abandon_provider_lookup_failed',
          err: error instanceof Error ? error.message : 'unknown',
        });
        return this.present(payment);
      }
    }
    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'CANCELLED',
        failureReason: 'checkout_dismissed',
        reconciliationStatus: 'OK',
      },
    });
    this.logger.log({
      event: 'payment_failed',
      paymentId: payment.id,
      reason: 'checkout_dismissed',
    });
    return this.present(updated);
  }

  async handleWebhook(rawBody: string, signature: string | undefined) {
    if (!this.provider.verifyWebhook(rawBody, signature)) {
      throw new AppError(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Invalid payment webhook signature',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const event = this.provider.parseWebhook(rawBody);
    const payloadHash = sha256(rawBody).slice(0, 128);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.providerEvent.create({
          data: {
            provider: this.provider.name,
            eventId: event.eventId,
            eventType: `payment.${event.status}`,
            payloadHash,
          },
        });

        const payment = await tx.payment.findUnique({
          where: { providerPaymentId: event.providerPaymentId },
        });
        if (!payment) {
          throw new AppError(
            ErrorCodes.NOT_FOUND,
            'Payment not found',
            HttpStatus.NOT_FOUND,
          );
        }

        const alreadyApplied =
          (event.status === 'succeeded' && payment.status === 'SUCCEEDED') ||
          (event.status === 'failed' && payment.status === 'FAILED') ||
          (event.status === 'cancelled' && payment.status === 'CANCELLED');
        if (alreadyApplied) {
          return { duplicate: true, paymentId: payment.id };
        }

        if (event.status === 'succeeded') {
          if (
            event.amountCents !== payment.amountCents ||
            (event.currency &&
              event.currency.toUpperCase() !== payment.currency.toUpperCase())
          ) {
            throw new AppError(
              ErrorCodes.PAYMENT_WEBHOOK_INVALID,
              'Webhook amount does not match payment',
              HttpStatus.CONFLICT,
            );
          }
          await this.wallet.applyLedger(
            {
              userId: payment.userId,
              type: 'CREDIT',
              reason: 'PAYMENT_TOPUP',
              amountCents: payment.creditCents ?? payment.amountCents,
              idempotencyKey: `payment:${payment.id}:credit`,
              referenceType: 'payment',
              referenceId: payment.id,
            },
            tx,
          );
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: 'SUCCEEDED',
              reconciliationStatus: 'OK',
              capturedAt: new Date(),
            },
          });
          this.logger.log({
            event: 'wallet_credit_applied',
            userId: payment.userId,
            paymentId: payment.id,
            amountCents: payment.creditCents ?? payment.amountCents,
          });
        } else if (event.status === 'failed') {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: 'FAILED',
              failureReason: event.failureReason ?? null,
            },
          });
          this.logger.log({
            event: 'payment_failed',
            paymentId: payment.id,
          });
        } else if (event.status === 'cancelled') {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'CANCELLED' },
          });
        } else {
          return { ignored: true, paymentId: payment.id };
        }

        return { duplicate: false, paymentId: payment.id };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.logger.log(
          { eventId: event.eventId },
          'duplicate payment webhook ignored',
        );
        return { duplicate: true };
      }
      throw error;
    }
  }

  async handleRazorpayWebhook(
    rawBody: string,
    signature: string | undefined,
    eventIdHeader?: string,
  ) {
    const razorpay = this.razorpay();
    if (!razorpay || this.provider.name !== 'razorpay') {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Not found',
        HttpStatus.NOT_FOUND,
      );
    }
    this.logger.log({
      event: 'razorpay_webhook_received',
      eventId: eventIdHeader ?? null,
    });
    if (!razorpay.verifyWebhook(rawBody, signature)) {
      throw new AppError(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Invalid payment webhook signature',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.logger.log({
      event: 'razorpay_webhook_verified',
      eventId: eventIdHeader ?? null,
    });
    const parsed = razorpay.parseWebhook(rawBody, eventIdHeader);
    if (parsed.status === 'ignored' || !parsed.providerPaymentId) {
      return { ignored: true, eventId: parsed.eventId };
    }
    if (parsed.status === 'failed') {
      return this.markFailedByOrder(
        parsed.providerPaymentId,
        parsed.failureReason ?? 'payment_failed',
        parsed.eventId,
        rawBody,
        parsed.providerCaptureId,
      );
    }
    if (parsed.status === 'refunded' || parsed.status === 'refund_failed') {
      return this.applyRefundEvent(parsed, rawBody);
    }
    if (parsed.status !== 'succeeded' || !parsed.providerCaptureId) {
      return { ignored: true, eventId: parsed.eventId };
    }
    const remote = await razorpay.fetchPayment(parsed.providerCaptureId);
    if (
      remote.amountPaise !== parsed.amountCents ||
      remote.currency.toUpperCase() !== parsed.currency.toUpperCase() ||
      remote.orderId !== parsed.providerPaymentId
    ) {
      const payment = await this.prisma.payment.findUnique({
        where: { providerPaymentId: parsed.providerPaymentId },
      });
      if (payment) {
        await this.flag(payment.id, 'AMOUNT_MISMATCH', remote.id);
      }
      this.logger.warn({
        event: 'payment_reconciliation_required',
        orderId: parsed.providerPaymentId,
        reason: 'webhook_amount_mismatch',
      });
      throw new AppError(
        ErrorCodes.CONFLICT,
        'Webhook amount does not match the Razorpay payment',
        HttpStatus.CONFLICT,
      );
    }
    if (remote.status !== 'captured') {
      return {
        ignored: true,
        eventId: parsed.eventId,
        providerStatus: remote.status,
      };
    }
    return this.creditCapturedPayment({
      orderId: remote.orderId,
      paymentId: remote.id,
      amountPaise: remote.amountPaise,
      currency: remote.currency,
      eventId: parsed.eventId,
      eventType: 'razorpay.webhook.captured',
      rawBody,
    });
  }

  /**
   * Admin repair: compare Razorpay with the internal row.
   * Credits only when Razorpay shows a captured payment that matches amount and currency.
   */
  async reconcile(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Payment not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const razorpay = this.razorpay();
    if (!razorpay || payment.provider !== 'razorpay') {
      const ledger = await this.prisma.walletLedgerEntry.findFirst({
        where: {
          referenceType: 'payment',
          referenceId: payment.id,
          reason: 'PAYMENT_TOPUP',
        },
      });
      const internalAhead = payment.status === 'SUCCEEDED' && !ledger;
      return {
        paymentId: payment.id,
        status: payment.status,
        reconciliationStatus: internalAhead
          ? 'INTERNAL_AHEAD'
          : payment.reconciliationStatus,
        provider: payment.provider,
        liveChecked: false,
      };
    }
    const order = await razorpay.fetchOrder(payment.providerPaymentId);
    const payments = await razorpay.fetchOrderPayments(
      payment.providerPaymentId,
    );
    const captured = payments.find((item) => item.status === 'captured');
    if (captured && payment.status !== 'SUCCEEDED') {
      const result = await this.creditCapturedPayment({
        orderId: captured.orderId,
        paymentId: captured.id,
        amountPaise: captured.amountPaise,
        currency: captured.currency,
        eventId: `reconcile:${captured.id}`,
        eventType: 'razorpay.reconcile',
      });
      return { ...result, reconciliationStatus: 'OK', liveChecked: true };
    }
    if (!captured && payment.status === 'SUCCEEDED') {
      await this.flag(payment.id, 'INTERNAL_AHEAD');
      this.logger.warn({
        event: 'payment_reconciliation_required',
        paymentId: payment.id,
        reason: 'internal_succeeded_without_capture',
      });
      return {
        paymentId: payment.id,
        status: payment.status,
        reconciliationStatus: 'INTERNAL_AHEAD',
        liveChecked: true,
        providerOrderStatus: order.status,
      };
    }
    if (captured && payment.status === 'SUCCEEDED') {
      const check = assessCapture(payment, {
        orderId: captured.orderId,
        amountPaise: captured.amountPaise,
        currency: captured.currency,
      });
      if (!check.ok) {
        await this.flag(payment.id, check.code, captured.id);
        return {
          paymentId: payment.id,
          reconciliationStatus: check.code,
          liveChecked: true,
          credited: false,
        };
      }
    }
    return {
      paymentId: payment.id,
      status: payment.status,
      reconciliationStatus: payment.status === 'SUCCEEDED' ? 'OK' : 'PENDING',
      liveChecked: true,
      providerOrderStatus: order.status,
    };
  }

  /**
   * Full Razorpay refund of a captured top-up. Debits the credited wallet amount
   * only when the available balance can cover it, then calls the Refund API.
   * Call-settlement refunds stay on POST /admin/calls/:id/refund.
   */
  async refundPayment(actorId: string, paymentId: string) {
    const razorpay = this.requireRazorpay();
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment || payment.provider !== 'razorpay') {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Payment not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (payment.status !== 'SUCCEEDED' || !payment.providerCaptureId) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Only a captured payment can be refunded',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (payment.refundStatus === 'PROCESSED') {
      return {
        duplicate: true,
        paymentId: payment.id,
        refundStatus: 'PROCESSED',
      };
    }
    if (payment.refundStatus === 'PENDING' && payment.providerRefundId) {
      return {
        duplicate: true,
        paymentId: payment.id,
        refundStatus: 'PENDING',
        providerRefundId: payment.providerRefundId,
      };
    }
    const attempt =
      payment.refundStatus === 'FAILED'
        ? payment.refundAttempt + 1
        : Math.max(payment.refundAttempt, 1);
    const debitKey = `payment:${payment.id}:refund:${attempt}`;
    const creditAmount = payment.creditCents ?? payment.amountCents;
    await this.wallet.applyLedger({
      userId: payment.userId,
      type: 'DEBIT',
      reason: 'PAYMENT_REFUND',
      amountCents: creditAmount,
      idempotencyKey: debitKey,
      referenceType: 'payment',
      referenceId: payment.id,
      metadata: { actorId, attempt },
    });
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { refundStatus: 'PENDING', refundAttempt: attempt },
    });
    try {
      const refund = await razorpay.createRefund({
        paymentId: payment.providerCaptureId,
        amountPaise: payment.amountCents,
        receipt: `${payment.id}:${attempt}`.slice(0, 40),
      });
      const processed = refund.status === 'processed';
      const updated = await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          providerRefundId: refund.id,
          refundStatus: processed ? 'PROCESSED' : 'PENDING',
          refundedAmountCents: refund.amountPaise,
        },
      });
      await this.prisma.auditLog.create({
        data: {
          actorId,
          action: 'payment.refund',
          targetType: 'payment',
          targetId: payment.id,
          metadata: {
            providerRefundId: refund.id,
            amountPaise: refund.amountPaise,
            walletDebitCents: creditAmount,
          },
        },
      });
      this.logger.log({
        event: 'payment_refunded',
        paymentId: payment.id,
        providerRefundId: refund.id,
        amountPaise: refund.amountPaise,
      });
      return this.present(updated);
    } catch (error) {
      await this.wallet.applyLedger({
        userId: payment.userId,
        type: 'CREDIT',
        reason: 'ADMIN_ADJUSTMENT',
        amountCents: creditAmount,
        idempotencyKey: `payment:${payment.id}:refund:${attempt}:reverse`,
        referenceType: 'payment',
        referenceId: payment.id,
        metadata: { reversalOf: debitKey },
      });
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          refundStatus: 'FAILED',
          refundAttempt: attempt,
          failureReason: 'refund_provider_failed',
        },
      });
      this.logger.warn({
        event: 'payment_reconciliation_required',
        paymentId: payment.id,
        reason: 'refund_provider_failed',
        err: error instanceof Error ? error.message : 'unknown',
      });
      throw new AppError(
        ErrorCodes.CONFLICT,
        'Razorpay refund was not created. The wallet debit was reversed.',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async creditCapturedPayment(input: CaptureInput) {
    const payment = await this.prisma.payment.findUnique({
      where: { providerPaymentId: input.orderId },
    });
    if (!payment) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Payment not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const check = assessCapture(payment, {
      orderId: input.orderId,
      amountPaise: input.amountPaise,
      currency: input.currency,
    });
    if (!check.ok) {
      await this.flag(payment.id, check.code, input.paymentId);
      this.logger.warn({
        event: 'payment_reconciliation_required',
        paymentId: payment.id,
        reason: check.code,
      });
      throw new AppError(
        ErrorCodes.CONFLICT,
        `Payment ${check.code}`,
        HttpStatus.CONFLICT,
      );
    }
    if (payment.status === 'SUCCEEDED') {
      return {
        duplicate: true,
        credited: false,
        paymentId: payment.id,
        status: 'SUCCEEDED' as const,
      };
    }
    const payloadHash = sha256(input.rawBody ?? input.eventId).slice(0, 128);
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.providerEvent.create({
          data: {
            provider: 'razorpay',
            eventId: input.eventId,
            eventType: input.eventType,
            payloadHash,
          },
        });
        const current = await tx.payment.findUnique({
          where: { id: payment.id },
        });
        if (!current) {
          throw new AppError(
            ErrorCodes.NOT_FOUND,
            'Payment not found',
            HttpStatus.NOT_FOUND,
          );
        }
        if (current.status === 'SUCCEEDED') {
          return { duplicate: true, credited: false, paymentId: current.id };
        }
        await this.assertWalletCurrency(current.userId, current.currency, tx);
        const credit = current.creditCents ?? current.amountCents;
        await this.wallet.applyLedger(
          {
            userId: current.userId,
            type: 'CREDIT',
            reason: 'PAYMENT_TOPUP',
            amountCents: credit,
            idempotencyKey: `payment:${current.id}:credit`,
            referenceType: 'payment',
            referenceId: current.id,
          },
          tx,
        );
        await tx.payment.update({
          where: { id: current.id },
          data: {
            status: 'SUCCEEDED',
            providerCaptureId: input.paymentId,
            capturedAt: new Date(),
            reconciliationStatus: 'OK',
            failureReason: null,
          },
        });
        this.logger.log({
          event: 'wallet_credit_applied',
          paymentId: current.id,
          userId: current.userId,
          amountCents: credit,
          currency: current.currency,
          orderId: current.providerPaymentId,
          providerPaymentId: input.paymentId,
        });
        return { duplicate: false, credited: true, paymentId: current.id };
      });
      return { ...result, status: 'SUCCEEDED' as const };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const again = await this.prisma.payment.findUnique({
          where: { id: payment.id },
        });
        return {
          duplicate: true,
          credited: false,
          paymentId: payment.id,
          status: again?.status ?? payment.status,
        };
      }
      if (
        error instanceof AppError &&
        error.message === 'Wallet currency does not match the payment'
      ) {
        await this.flag(payment.id, 'CURRENCY_MISMATCH', input.paymentId);
      }
      throw error;
    }
  }

  present(payment: Payment) {
    const view: Record<string, unknown> = {
      id: payment.id,
      status: payment.status,
      provider: payment.provider,
      amountCents: payment.amountCents,
      creditCents: payment.creditCents,
      currency: payment.currency,
      providerPaymentId: payment.providerPaymentId,
      providerCaptureId: payment.providerCaptureId,
      refundStatus: payment.refundStatus,
      reconciliationStatus: payment.reconciliationStatus,
      failureReason: payment.failureReason,
      createdAt: payment.createdAt,
      capturedAt: payment.capturedAt,
    };
    if (
      payment.provider === 'razorpay' &&
      (payment.status === 'PENDING' || payment.status === 'REQUIRES_ACTION')
    ) {
      view.checkout = {
        keyId: this.config.get('RAZORPAY_KEY_ID'),
        orderId: payment.providerPaymentId,
        amount: payment.amountCents,
        currency: payment.currency,
        name: 'Gmatez',
      };
    } else if (payment.provider !== 'razorpay' && payment.clientSecret) {
      view.clientSecret = payment.clientSecret;
    }
    return view;
  }

  private async resolvePlanCharge(
    amountCents: number | undefined,
    rechargePlanId?: string,
  ) {
    if (this.provider.name === 'razorpay' && !rechargePlanId) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'rechargePlanId is required',
      );
    }
    if (!rechargePlanId) {
      if (amountCents == null) {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED,
          'amountCents or rechargePlanId is required',
        );
      }
      return {
        amountCents,
        creditCents: amountCents,
        rechargePlanId: null as string | null,
      };
    }
    const plan = await this.prisma.rechargePlan.findUnique({
      where: { id: rechargePlanId },
    });
    if (!plan || !plan.isActive) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Recharge plan is not available',
      );
    }
    if (amountCents != null && amountCents !== plan.priceMinor) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Amount must match the recharge plan price',
      );
    }
    return {
      amountCents: plan.priceMinor,
      creditCents: plan.walletCreditMinor,
      rechargePlanId: plan.id,
    };
  }

  private razorpay(): RazorpayPaymentProvider | null {
    return this.provider.name === 'razorpay'
      ? (this.provider as RazorpayPaymentProvider)
      : null;
  }

  private requireRazorpay(): RazorpayPaymentProvider {
    const provider = this.razorpay();
    if (!provider) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Razorpay is not the active payment provider',
        HttpStatus.NOT_FOUND,
      );
    }
    return provider;
  }

  private async assertWalletCurrency(
    userId: string,
    currency: string,
    tx: Prisma.TransactionClient,
  ) {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Wallet not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (wallet.currency === currency) {
      return;
    }
    const entries = await tx.walletLedgerEntry.count({
      where: { walletId: wallet.id },
    });
    if (
      entries === 0 &&
      wallet.availableBalanceCents === 0 &&
      wallet.heldBalanceCents === 0
    ) {
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { currency },
      });
      return;
    }
    throw new AppError(
      ErrorCodes.CONFLICT,
      'Wallet currency does not match the payment',
      HttpStatus.CONFLICT,
    );
  }

  private async flag(
    paymentId: string,
    reconciliationStatus: string,
    providerCaptureId?: string,
  ) {
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        reconciliationStatus,
        ...(providerCaptureId ? { providerCaptureId } : {}),
      },
    });
  }

  private async markFailed(paymentId: string, reason: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment || payment.status === 'SUCCEEDED') {
      return { duplicate: true, paymentId, status: payment?.status };
    }
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'FAILED', failureReason: reason.slice(0, 180) },
    });
    this.logger.log({ event: 'payment_failed', paymentId, reason });
    return { credited: false, paymentId, status: 'FAILED' as const };
  }

  private async markFailedByOrder(
    orderId: string,
    reason: string,
    eventId: string,
    rawBody: string,
    providerCaptureId?: string,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.providerEvent.create({
          data: {
            provider: 'razorpay',
            eventId,
            eventType: 'razorpay.payment.failed',
            payloadHash: sha256(rawBody).slice(0, 128),
          },
        });
        const payment = await tx.payment.findUnique({
          where: { providerPaymentId: orderId },
        });
        if (!payment) {
          return { ignored: true, reason: 'unknown_payment' };
        }
        if (payment.status === 'SUCCEEDED') {
          return {
            ignored: true,
            paymentId: payment.id,
            reason: 'already_succeeded',
          };
        }
        if (payment.status === 'FAILED') {
          return { duplicate: true, paymentId: payment.id, status: 'FAILED' };
        }
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'FAILED',
            failureReason: reason.slice(0, 180),
            ...(providerCaptureId ? { providerCaptureId } : {}),
          },
        });
        this.logger.log({
          event: 'payment_failed',
          paymentId: payment.id,
          reason,
        });
        return {
          credited: false,
          paymentId: payment.id,
          status: 'FAILED' as const,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { duplicate: true };
      }
      throw error;
    }
  }

  private async applyRefundEvent(
    parsed: {
      status: string;
      eventId: string;
      providerCaptureId?: string;
      refundId?: string;
      amountCents: number;
    },
    rawBody: string,
  ) {
    const payment = parsed.providerCaptureId
      ? await this.prisma.payment.findFirst({
          where: { providerCaptureId: parsed.providerCaptureId },
        })
      : null;
    if (!payment) {
      return { ignored: true, reason: 'unknown_payment' };
    }
    if (payment.refundStatus === 'PROCESSED') {
      return {
        duplicate: true,
        paymentId: payment.id,
        refundStatus: 'PROCESSED',
      };
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.providerEvent.create({
          data: {
            provider: 'razorpay',
            eventId: parsed.eventId,
            eventType: `razorpay.${parsed.status}`,
            payloadHash: sha256(rawBody).slice(0, 128),
          },
        });
        const current = await tx.payment.findUnique({
          where: { id: payment.id },
        });
        if (!current || current.refundStatus === 'PROCESSED') {
          return {
            duplicate: true,
            paymentId: payment.id,
            refundStatus: 'PROCESSED' as const,
          };
        }
        if (parsed.status === 'refund_failed') {
          if (current.refundStatus !== 'PENDING') {
            return { ignored: true, paymentId: current.id };
          }
          const credit = current.creditCents ?? current.amountCents;
          await this.wallet.applyLedger(
            {
              userId: current.userId,
              type: 'CREDIT',
              reason: 'ADMIN_ADJUSTMENT',
              amountCents: credit,
              idempotencyKey: `payment:${current.id}:refund:${current.refundAttempt}:reverse`,
              referenceType: 'payment',
              referenceId: current.id,
              metadata: { reversalOf: 'provider_refund_failed' },
            },
            tx,
          );
          await tx.payment.update({
            where: { id: current.id },
            data: { refundStatus: 'FAILED', failureReason: 'refund_failed' },
          });
          return { paymentId: current.id, refundStatus: 'FAILED' as const };
        }
        if (current.refundStatus !== 'PENDING') {
          try {
            await this.wallet.applyLedger(
              {
                userId: current.userId,
                type: 'DEBIT',
                reason: 'PAYMENT_REFUND',
                amountCents: current.creditCents ?? current.amountCents,
                idempotencyKey: `payment:${current.id}:refund:webhook`,
                referenceType: 'payment',
                referenceId: current.id,
                metadata: { providerRefundId: parsed.refundId },
              },
              tx,
            );
          } catch (error) {
            if (
              error instanceof AppError &&
              error.code === ErrorCodes.WALLET_INSUFFICIENT_FUNDS
            ) {
              await tx.payment.update({
                where: { id: current.id },
                data: { reconciliationStatus: 'PROVIDER_AHEAD' },
              });
              this.logger.warn({
                event: 'payment_reconciliation_required',
                paymentId: current.id,
                reason: 'refund_without_wallet_balance',
              });
              return {
                paymentId: current.id,
                reconciliationStatus: 'PROVIDER_AHEAD' as const,
                credited: false,
              };
            }
            throw error;
          }
        }
        await tx.payment.update({
          where: { id: current.id },
          data: {
            refundStatus: 'PROCESSED',
            providerRefundId: parsed.refundId ?? current.providerRefundId,
            refundedAmountCents: parsed.amountCents || current.amountCents,
          },
        });
        this.logger.log({
          event: 'payment_refunded',
          paymentId: current.id,
          providerRefundId: parsed.refundId,
        });
        return { paymentId: current.id, refundStatus: 'PROCESSED' as const };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { duplicate: true, paymentId: payment.id };
      }
      throw error;
    }
  }
}
