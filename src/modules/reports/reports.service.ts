import { HttpStatus, Injectable } from '@nestjs/common';
import { ReportReason } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppError, ErrorCodes } from '../../common/errors/app-error';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    reporterId: string,
    reportedId: string,
    reason: ReportReason,
    details: string,
    referenceType?: string,
    referenceId?: string,
  ) {
    if (reporterId === reportedId) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Cannot report yourself',
      );
    }
    const target = await this.prisma.user.findUnique({
      where: { id: reportedId },
    });
    if (!target) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'User not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (referenceType && referenceId) {
      if (referenceType === 'call') {
        const call = await this.prisma.call.findUnique({
          where: { id: referenceId },
        });
        if (
          !call ||
          (call.callerId !== reporterId && call.calleeId !== reporterId)
        ) {
          throw new AppError(
            ErrorCodes.FORBIDDEN,
            'Not a participant of referenced call',
            HttpStatus.FORBIDDEN,
          );
        }
      }
      if (referenceType === 'conversation') {
        const conversation = await this.prisma.conversation.findUnique({
          where: { id: referenceId },
        });
        if (
          !conversation ||
          (conversation.participantAId !== reporterId &&
            conversation.participantBId !== reporterId)
        ) {
          throw new AppError(
            ErrorCodes.FORBIDDEN,
            'Not a participant of referenced conversation',
            HttpStatus.FORBIDDEN,
          );
        }
      }
    }
    const recent = await this.prisma.report.findFirst({
      where: {
        reporterId,
        reportedId,
        createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (recent) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        'You already reported this user recently',
        HttpStatus.CONFLICT,
      );
    }
    return this.prisma.report.create({
      data: {
        reporterId,
        reportedId,
        reason,
        details,
        referenceType: referenceType ?? null,
        referenceId: referenceId ?? null,
      },
    });
  }
}
