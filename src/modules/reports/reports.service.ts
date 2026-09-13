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
      data: { reporterId, reportedId, reason, details },
    });
  }
}
