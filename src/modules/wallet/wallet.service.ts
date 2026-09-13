import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import {
  CursorPage,
  decodeCursor,
  encodeCursor,
} from '../../common/dto/pagination.dto';

export type LedgerMutation = {
  userId: string;
  type: 'CREDIT' | 'DEBIT';
  reason:
    | 'PAYMENT_TOPUP'
    | 'CALL_CHARGE'
    | 'CALL_REFUND'
    | 'ADMIN_ADJUSTMENT'
    | 'PROMOTIONAL_CREDIT'
    | 'CREATOR_EARNING'
    | 'PAYOUT';
  amountCents: number;
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getByUserId(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Wallet not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return wallet;
  }

  async listLedger(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<
    CursorPage<{
      id: string;
      type: string;
      reason: string;
      amountCents: number;
      balanceAfterCents: number;
      createdAt: Date;
    }>
  > {
    const wallet = await this.getByUserId(userId);
    const cursorFilter = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.prisma.walletLedgerEntry.findMany({
      where: {
        walletId: wallet.id,
        ...(cursorFilter
          ? {
              OR: [
                { createdAt: { lt: cursorFilter.createdAt } },
                {
                  createdAt: cursorFilter.createdAt,
                  id: { lt: cursorFilter.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map((row) => ({
        id: row.id,
        type: row.type,
        reason: row.reason,
        amountCents: row.amountCents,
        balanceAfterCents: row.balanceAfterCents,
        createdAt: row.createdAt,
      })),
      nextCursor:
        hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async applyLedger(
    mutation: LedgerMutation,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    if (mutation.amountCents <= 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Amount must be positive',
      );
    }
    const run = async (tx: Prisma.TransactionClient | PrismaService) => {
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE "userId" = ${mutation.userId} FOR UPDATE`;
      const wallet = await tx.wallet.findUnique({
        where: { userId: mutation.userId },
      });
      if (!wallet) {
        throw new AppError(
          ErrorCodes.NOT_FOUND,
          'Wallet not found',
          HttpStatus.NOT_FOUND,
        );
      }

      const existing = await tx.walletLedgerEntry.findUnique({
        where: { idempotencyKey: mutation.idempotencyKey },
      });
      if (existing) {
        return { wallet, entry: existing, duplicate: true };
      }

      if (
        mutation.type === 'DEBIT' &&
        wallet.availableBalanceCents < mutation.amountCents
      ) {
        throw new AppError(
          ErrorCodes.WALLET_INSUFFICIENT_FUNDS,
          'Insufficient available balance',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const nextAvailable =
        mutation.type === 'CREDIT'
          ? wallet.availableBalanceCents + mutation.amountCents
          : wallet.availableBalanceCents - mutation.amountCents;

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableBalanceCents: nextAvailable,
          version: { increment: 1 },
        },
      });

      const entry = await tx.walletLedgerEntry.create({
        data: {
          walletId: wallet.id,
          type: mutation.type,
          reason: mutation.reason,
          amountCents: mutation.amountCents,
          balanceAfterCents: nextAvailable + updated.heldBalanceCents,
          idempotencyKey: mutation.idempotencyKey,
          referenceType: mutation.referenceType,
          referenceId: mutation.referenceId,
          metadata: mutation.metadata as Prisma.InputJsonValue | undefined,
        },
      });

      this.logger.log({
        userId: mutation.userId,
        type: mutation.type,
        reason: mutation.reason,
        amountCents: mutation.amountCents,
        idempotencyKey: mutation.idempotencyKey,
      });
      return { wallet: updated, entry, duplicate: false };
    };

    try {
      if (client === this.prisma) {
        return await this.prisma.$transaction((tx) => run(tx));
      }
      return await run(client);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const wallet = await this.getByUserId(mutation.userId);
        const entry = await this.prisma.walletLedgerEntry.findUnique({
          where: { idempotencyKey: mutation.idempotencyKey },
        });
        if (entry) {
          return { wallet, entry, duplicate: true };
        }
      }
      throw error;
    }
  }

  async hold(
    userId: string,
    amountCents: number,
    callId: string,
  ): Promise<void> {
    if (amountCents <= 0) {
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        throw new AppError(
          ErrorCodes.NOT_FOUND,
          'Wallet not found',
          HttpStatus.NOT_FOUND,
        );
      }
      if (wallet.availableBalanceCents < amountCents) {
        throw new AppError(
          ErrorCodes.WALLET_INSUFFICIENT_FUNDS,
          'Insufficient available balance',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableBalanceCents: { decrement: amountCents },
          heldBalanceCents: { increment: amountCents },
          version: { increment: 1 },
        },
      });
      await tx.call.update({
        where: { id: callId },
        data: { heldAmountCents: { increment: amountCents } },
      });
    });
  }

  async settleCallCharge(input: {
    userId: string;
    callId: string;
    amountCents: number;
    idempotencyKey: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE "userId" = ${input.userId} FOR UPDATE`;
      const wallet = await tx.wallet.findUnique({
        where: { userId: input.userId },
      });
      if (!wallet) {
        throw new AppError(
          ErrorCodes.NOT_FOUND,
          'Wallet not found',
          HttpStatus.NOT_FOUND,
        );
      }
      const call = await tx.call.findUnique({ where: { id: input.callId } });
      if (!call) {
        throw new AppError(
          ErrorCodes.NOT_FOUND,
          'Call not found',
          HttpStatus.NOT_FOUND,
        );
      }

      const existing = await tx.walletLedgerEntry.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        return { duplicate: true, wallet, entry: existing };
      }

      const held = call.heldAmountCents;
      const charge = input.amountCents;
      const extraDebit = Math.max(charge - held, 0);
      const leftoverHold = Math.max(held - charge, 0);
      if (extraDebit > wallet.availableBalanceCents) {
        throw new AppError(
          ErrorCodes.WALLET_INSUFFICIENT_FUNDS,
          'Insufficient funds to settle call',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const nextHeld = wallet.heldBalanceCents - held;
      const available =
        wallet.availableBalanceCents + leftoverHold - extraDebit;

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableBalanceCents: available,
          heldBalanceCents: nextHeld,
          version: { increment: 1 },
        },
      });

      const entry =
        input.amountCents > 0
          ? await tx.walletLedgerEntry.create({
              data: {
                walletId: wallet.id,
                type: 'DEBIT',
                reason: 'CALL_CHARGE',
                amountCents: input.amountCents,
                balanceAfterCents: available + nextHeld,
                idempotencyKey: input.idempotencyKey,
                referenceType: 'call',
                referenceId: input.callId,
              },
            })
          : null;

      await tx.call.update({
        where: { id: input.callId },
        data: {
          billedAmountCents: input.amountCents,
          heldAmountCents: 0,
        },
      });

      return { duplicate: false, wallet: updated, entry };
    });
  }

  async earningsSummary(userId: string) {
    const wallet = await this.getByUserId(userId);
    const grouped = await this.prisma.walletLedgerEntry.groupBy({
      by: ['reason'],
      where: { walletId: wallet.id, reason: { in: ['CREATOR_EARNING', 'PAYOUT'] } },
      _sum: { amountCents: true },
    });
    const earned =
      grouped.find((row) => row.reason === 'CREATOR_EARNING')?._sum.amountCents ??
      0;
    const paidOut =
      grouped.find((row) => row.reason === 'PAYOUT')?._sum.amountCents ?? 0;
    const pending = await this.prisma.payoutRequest.aggregate({
      where: { userId, status: { in: ['REQUESTED', 'PROCESSING'] } },
      _sum: { amountCents: true },
    });
    return {
      currency: wallet.currency,
      availableBalanceCents: wallet.availableBalanceCents,
      heldBalanceCents: wallet.heldBalanceCents,
      lifetimeEarnedCents: earned,
      lifetimePaidOutCents: paidOut,
      pendingPayoutCents: pending._sum.amountCents ?? 0,
    };
  }

  async releaseHold(userId: string, callId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
      const call = await tx.call.findUnique({ where: { id: callId } });
      if (!call || call.heldAmountCents <= 0) {
        return;
      }
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        return;
      }
      const amount = Math.min(call.heldAmountCents, wallet.heldBalanceCents);
      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableBalanceCents: { increment: amount },
          heldBalanceCents: { decrement: amount },
          version: { increment: 1 },
        },
      });
      await tx.call.update({
        where: { id: callId },
        data: { heldAmountCents: 0 },
      });
    });
  }
}
