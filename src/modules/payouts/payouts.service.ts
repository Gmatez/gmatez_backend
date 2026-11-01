import { HttpStatus, Injectable } from '@nestjs/common';
import { PayoutStatus, Prisma } from '@prisma/client';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { HostsService } from '../hosts/hosts.service';
import { NotificationsService } from '../notifications/notifications.service';

const MIN_PAYOUT_CENTS = 500;

@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly hosts: HostsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Authoritative payout rules. No external payout rail is integrated. */
  rules() {
    return {
      minimumAmountCents: MIN_PAYOUT_CENTS,
      payoutRailStatus: 'CONFIG_REQUIRED' as const,
      payoutRailCode: 'PAYOUT_PROVIDER_CONFIG_REQUIRED',
      payoutRail: 'RAZORPAYX' as const,
      moneyTransferred: false,
      externalTransferStatus: 'NOT_TRANSFERRED' as const,
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
        await tx.$queryRaw`SELECT id FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
        const pendingInTx = await tx.payoutRequest.findFirst({
          where: { userId, status: { in: ['REQUESTED', 'PROCESSING'] } },
        });
        if (pendingInTx) {
          // Two concurrent requests sharing an idempotencyKey both pass the
          // (unlocked) checks above, then serialize on the wallet row lock
          // below — the loser lands here and sees the winner's own
          // just-committed row. That's not a real conflict; return it
          // instead of a 409, same as the idempotency check earlier in
          // this method would have if it had run after the winner's commit.
          if (pendingInTx.idempotencyKey === idempotencyKey) {
            return pendingInTx;
          }
          throw new AppError(
            ErrorCodes.PAYOUT_NOT_ELIGIBLE,
            'A payout is already pending',
            HttpStatus.CONFLICT,
          );
        }
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
    providerTransferId?: string,
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
    // No payout rail (RazorpayX etc.) is integrated, so the app can never
    // discover on its own that a transfer happened. COMPLETED is allowed
    // only as a manual confirmation: the admin made the bank/UPI transfer
    // themselves outside this app and records the reference here as proof,
    // rather than the status silently being unreachable forever.
    if (status === 'COMPLETED') {
      const reference = providerTransferId?.trim();
      if (!reference) {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED,
          'providerTransferId is required to mark a payout COMPLETED — record the bank/UPI reference for the transfer you made.',
        );
      }
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
        ...(status === 'COMPLETED'
          ? {
              providerTransferId: providerTransferId!.trim(),
              externalTransferStatus: 'MANUALLY_CONFIRMED',
            }
          : {}),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: `payout.${status.toLowerCase()}`,
        targetType: 'payout',
        targetId: payoutId,
        ...(providerTransferId ? { metadata: { providerTransferId } } : {}),
      },
    });
    await this.notifyStatus(payout.userId, payoutId, status).catch(() => {
      // A notification failure must never fail the status update itself —
      // the wallet ledger/audit log above already committed.
    });
    return updated;
  }

  private async notifyStatus(
    userId: string,
    payoutId: string,
    status: PayoutStatus,
  ) {
    const copy: Partial<Record<PayoutStatus, { title: string; body: string }>> =
      {
        PROCESSING: {
          title: 'Payout processing',
          body: 'Your payout request is being processed.',
        },
        COMPLETED: {
          title: 'Payout sent',
          body: 'Your payout has been transferred.',
        },
        REJECTED: {
          title: 'Payout rejected',
          body: 'Your payout request was rejected and the amount was returned to your wallet.',
        },
        FAILED: {
          title: 'Payout failed',
          body: 'Your payout could not be completed and the amount was returned to your wallet.',
        },
      };
    const message = copy[status];
    if (!message) {
      return;
    }
    await this.notifications.notifyUser(userId, {
      type: 'payout',
      title: message.title,
      body: message.body,
      data: { type: 'payout', payoutId },
    });
  }
}
