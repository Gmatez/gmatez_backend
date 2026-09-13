import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PAYMENT_PROVIDER } from '../../providers/payments/payment.tokens';
import type { PaymentProvider } from '../../providers/payments/payment-provider';
import { AppConfigService } from '../../config/app-config';
import { hmacSha256 } from '../../common/crypto/hashing';
import { WalletService } from '../wallet/wallet.service';

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
    amountCents: number,
    idempotencyKey: string,
  ) {
    if (amountCents < 100) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Minimum top-up is 100 cents',
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
      return existing;
    }

    const intent = await this.provider.createIntent({
      amountCents,
      currency: 'USD',
      userId,
      idempotencyKey,
    });

    try {
      return await this.prisma.payment.create({
        data: {
          userId,
          amountCents,
          currency: 'USD',
          status: 'PENDING',
          provider: this.provider.name,
          providerPaymentId: intent.providerPaymentId,
          idempotencyKey,
          clientSecret: intent.clientSecret,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const payment = await this.prisma.payment.findUnique({
          where: { idempotencyKey },
        });
        if (payment) {
          return payment;
        }
      }
      throw error;
    }
  }

  async sandboxConfirm(userId: string, paymentId: string) {
    if (!this.config.allowsMockSandbox || this.provider.name !== 'mock') {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Not found', HttpStatus.NOT_FOUND);
    }
    const payment = await this.getOwn(userId, paymentId);
    if (payment.status === 'SUCCEEDED') {
      return { duplicate: true, paymentId: payment.id };
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

  async handleWebhook(rawBody: string, signature: string | undefined) {
    if (!this.provider.verifyWebhook(rawBody, signature)) {
      throw new AppError(
        ErrorCodes.PAYMENT_WEBHOOK_INVALID,
        'Invalid payment webhook signature',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const event = this.provider.parseWebhook(rawBody);
    const payloadHash = Buffer.from(rawBody).toString('base64').slice(0, 128);

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
          if (event.amountCents !== payment.amountCents) {
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
              amountCents: payment.amountCents,
              idempotencyKey: `payment:${payment.id}:credit`,
              referenceType: 'payment',
              referenceId: payment.id,
            },
            tx,
          );
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'SUCCEEDED' },
          });
          this.logger.log({
            userId: payment.userId,
            paymentId: payment.id,
            amountCents: payment.amountCents,
          });
        } else if (event.status === 'failed') {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'FAILED' },
          });
        } else {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'CANCELLED' },
          });
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
}
