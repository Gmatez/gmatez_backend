import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';

export type RechargeInput = {
  name?: string;
  priceMinor?: number;
  walletCreditMinor?: number;
  bonusMinor?: number;
  coins?: number;
  bonusCoins?: number;
  description?: string;
  isActive?: boolean;
  displayOrder?: number;
};

@Injectable()
export class RechargeService {
  constructor(private readonly prisma: PrismaService) {}

  listActive() {
    return this.prisma.rechargePlan.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async userCallRate() {
    const pricing = await this.prisma.platformPricing.findUnique({
      where: { id: 'default' },
      select: { userRatePerMinuteCents: true },
    });
    return {
      userRatePerMinuteCents: pricing?.userRatePerMinuteCents ?? null,
    };
  }

  listAll() {
    return this.prisma.rechargePlan.findMany({
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async create(actorId: string, input: RechargeInput) {
    const data = this.normalize(input, true);
    const plan = await this.prisma.rechargePlan.create({
      data: data as Prisma.RechargePlanCreateInput,
    });
    await this.audit(actorId, 'recharge_plan.create', plan.id, {
      name: plan.name,
    });
    return plan;
  }

  async update(actorId: string, id: string, input: RechargeInput) {
    await this.require(id);
    const plan = await this.prisma.rechargePlan.update({
      where: { id },
      data: this.normalize(input, false),
    });
    await this.audit(actorId, 'recharge_plan.update', id, {
      name: plan.name,
      isActive: plan.isActive,
    });
    return plan;
  }

  async remove(actorId: string, id: string) {
    await this.require(id);
    await this.prisma.rechargePlan.delete({ where: { id } });
    await this.audit(actorId, 'recharge_plan.delete', id, {});
    return { id, deleted: true };
  }

  private async require(id: string) {
    const plan = await this.prisma.rechargePlan.findUnique({ where: { id } });
    if (!plan) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Recharge plan not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return plan;
  }

  private normalize(
    input: RechargeInput,
    creating: boolean,
  ): Prisma.RechargePlanUpdateInput {
    const priceMinor = input.priceMinor;
    const coins = this.coinCount(input.coins, 'Coins');
    const bonusCoins = this.coinCount(input.bonusCoins, 'Bonus coins', true);
    const walletCreditMinor =
      coins != null ? coins * 10 : input.walletCreditMinor;
    const bonusMinor =
      bonusCoins != null ? bonusCoins * 10 : (input.bonusMinor ?? 0);
    if (
      creating &&
      (!input.name?.trim() || priceMinor == null || coins == null)
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Name, price, and coins are required',
      );
    }
    if (
      priceMinor != null &&
      (!Number.isInteger(priceMinor) || priceMinor <= 0)
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Price must be a positive minor amount',
      );
    }
    if (
      walletCreditMinor != null &&
      (!Number.isInteger(walletCreditMinor) || walletCreditMinor <= 0)
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Wallet credit must be a positive minor amount',
      );
    }
    if (!Number.isInteger(bonusMinor) || bonusMinor < 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Bonus cannot be negative',
      );
    }
    return {
      ...(input.name != null ? { name: input.name.trim().slice(0, 80) } : {}),
      ...(priceMinor != null ? { priceMinor } : {}),
      ...(walletCreditMinor != null ? { walletCreditMinor } : {}),
      ...(coins != null ? { coins } : {}),
      ...(bonusCoins != null ? { bonusCoins, bonusMinor } : {}),
      ...(bonusCoins == null && input.bonusMinor != null ? { bonusMinor } : {}),
      ...(input.description != null
        ? { description: input.description.slice(0, 240) }
        : {}),
      ...(input.isActive != null ? { isActive: input.isActive } : {}),
      ...(input.displayOrder != null
        ? { displayOrder: input.displayOrder }
        : {}),
    };
  }

  private coinCount(
    value: number | undefined,
    label: string,
    allowZero = false,
  ): number | undefined {
    if (value == null) {
      return undefined;
    }
    if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 1_000_000) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        `${label} must be a whole number${allowZero ? '' : ' of at least 1'}`,
      );
    }
    return value;
  }

  private async audit(
    actorId: string,
    action: string,
    id: string,
    metadata: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action,
        targetType: 'recharge_plan',
        targetId: id,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}
