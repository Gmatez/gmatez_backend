import { HttpStatus, Injectable } from '@nestjs/common';
import { PayoutStatus } from '@prisma/client';
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

    return this.prisma.$transaction(async (tx) => {
      await this.wallet.applyLedger(
        {
          userId,
          type: 'DEBIT',
          reason: 'PAYOUT',
          amountCents,
          idempotencyKey: `payout:${idempotencyKey}`,
          referenceType: 'payout',
          metadata: { status: 'REQUESTED' },
        },
        tx,
      );
      return tx.payoutRequest.create({
        data: {
          userId,
          amountCents,
          idempotencyKey,
          status: 'REQUESTED',
        },
      });
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
      throw new AppError(ErrorCodes.NOT_FOUND, 'Payout not found', HttpStatus.NOT_FOUND);
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
