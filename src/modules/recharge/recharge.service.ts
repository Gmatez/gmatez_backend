import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';

export type RechargeInput = {
  name?: string;
  priceMinor?: number;
  walletCreditMinor?: number;
  bonusMinor?: number;
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
    const walletCreditMinor = input.walletCreditMinor;
    if (
      creating &&
      (!input.name?.trim() || priceMinor == null || walletCreditMinor == null)
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Name, price, and wallet credit are required',
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
    const bonusMinor = input.bonusMinor ?? 0;
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
      ...(input.bonusMinor != null ? { bonusMinor } : {}),
      ...(input.description != null
        ? { description: input.description.slice(0, 240) }
        : {}),
      ...(input.isActive != null ? { isActive: input.isActive } : {}),
      ...(input.displayOrder != null
        ? { displayOrder: input.displayOrder }
        : {}),
    };
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
