import { HttpStatus, Injectable } from '@nestjs/common';
import { PayoutStatus, Prisma } from '@prisma/client';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { HostsService } from '../hosts/hosts.service';

const MIN_PAYOUT_CENTS = 500;

@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly hosts: HostsService,
  ) {}

  /** Authoritative payout rules. No external payout rail is integrated. */
  rules() {
    return {
      minimumAmountCents: MIN_PAYOUT_CENTS,
      payoutRailStatus: 'CONFIG_REQUIRED' as const,
      payoutRailCode: 'PAYOUT_PROVIDER_CONFIG_REQUIRED',
    };
  }

  async request(userId: string, amountCents: number, idempotencyKey: string) {
    if (amountCents < MIN_PAYOUT_CENTS) {
      throw new AppError(
        ErrorCodes.PAYOUT_NOT_ELIGIBLE,
        `Minimum payout is ${MIN_PAYOUT_CENTS} cents`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    await this.hosts.requireActiveHost(userId);
    const existing = await this.prisma.payoutRequest.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      if (existing.userId !== userId) {
        throw new AppError(
          ErrorCodes.CONFLICT,
          'Idempotency key already used',
          HttpStatus.CONFLICT,
        );
      }
      return existing;
    }
    const destination = await this.prisma.payoutDestination.findFirst({
      where: { userId, isDefault: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!destination) {
      throw new AppError(
        ErrorCodes.PAYOUT_NOT_ELIGIBLE,
        'Add a payout destination before requesting a payout',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const pending = await this.prisma.payoutRequest.findFirst({
      where: { userId, status: { in: ['REQUESTED', 'PROCESSING'] } },
    });
    if (pending) {
      throw new AppError(
        ErrorCodes.PAYOUT_NOT_ELIGIBLE,
        'A payout is already pending',
        HttpStatus.CONFLICT,
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.wallet.applyLedger(
          {
            userId,
            type: 'DEBIT',
            reason: 'PAYOUT',
            amountCents,
            idempotencyKey: `payout:${idempotencyKey}`,
            referenceType: 'payout',
            metadata: { status: 'REQUESTED', destinationId: destination.id },
          },
          tx,
        );
        return tx.payoutRequest.create({
          data: {
            userId,
            destinationId: destination.id,
            amountCents,
            idempotencyKey,
            status: 'REQUESTED',
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.payoutRequest.findUnique({
          where: { idempotencyKey },
        });
        if (raced && raced.userId === userId) {
          return raced;
        }
      }
      throw error;
    }
  }

  async upsertDestination(
    userId: string,
    input: {
      type: string;
      label?: string;
      details: Record<string, unknown>;
    },
  ) {
    await this.hosts.requireActiveHost(userId);
    const type = input.type.trim().toUpperCase();
    if (!['BANK', 'UPI', 'PAYPAL', 'OTHER'].includes(type)) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Invalid payout destination type',
      );
    }
    await this.prisma.payoutDestination.updateMany({
      where: { userId },
      data: { isDefault: false },
    });
    return this.prisma.payoutDestination.create({
      data: {
        userId,
        type,
        label: input.label?.slice(0, 80) ?? '',
        detailsJson: input.details as Prisma.InputJsonValue,
        isDefault: true,
      },
    });
  }

  listDestinations(userId: string) {
    return this.prisma.payoutDestination.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      take: 20,
    });
  }

  list(userId: string) {
    return this.prisma.payoutRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  listAll(status?: PayoutStatus) {
    return this.prisma.payoutRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async adminSetStatus(
    actorId: string,
    payoutId: string,
    status: PayoutStatus,
    failureReason?: string,
  ) {
    const payout = await this.prisma.payoutRequest.findUnique({
      where: { id: payoutId },
    });
    if (!payout) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Payout not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (payout.status === 'COMPLETED' || payout.status === 'REJECTED') {
      throw new AppError(
        ErrorCodes.CONFLICT,
        'Payout is already terminal',
        HttpStatus.CONFLICT,
      );
    }
    if (status === 'REJECTED' || status === 'FAILED') {
      await this.wallet.applyLedger({
        userId: payout.userId,
        type: 'CREDIT',
        reason: 'ADMIN_ADJUSTMENT',
        amountCents: payout.amountCents,
        idempotencyKey: `payout:${payout.id}:reverse`,
        referenceType: 'payout',
        referenceId: payout.id,
        metadata: { reversalOf: payout.status },
      });
    }
    const updated = await this.prisma.payoutRequest.update({
      where: { id: payoutId },
      data: {
        status,
        failureReason: failureReason ?? null,
        processedAt: status === 'REQUESTED' ? null : new Date(),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: `payout.${status.toLowerCase()}`,
        targetType: 'payout',
        targetId: payoutId,
      },
    });
    return updated;
  }
}
