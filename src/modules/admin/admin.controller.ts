import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import {
  HostStatus,
  HostVerificationStatus,
  PayoutStatus,
  ReportStatus,
  UserStatus,
} from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/public.decorator';
import { AdminService } from './admin.service';

export class SetUserStatusDto {
  @ApiProperty({ enum: UserStatus })
  @IsEnum(UserStatus)
  status!: UserStatus;
}

export class WalletAdjustmentDto {
  @ApiProperty()
  @IsString()
  userId!: string;

  @ApiProperty({
    description: 'Signed cents. Positive credit, negative debit.',
  })
  @IsInt()
  amountCents!: number;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  reason!: string;
}

export class ResolveReportDto {
  @ApiProperty({ enum: ReportStatus })
  @IsEnum(ReportStatus)
  status!: ReportStatus;
}

export class ResolvePayoutDto {
  @ApiProperty({ enum: PayoutStatus })
  @IsEnum(PayoutStatus)
  status!: PayoutStatus;
}

export class SetHostStatusDto {
  @ApiProperty({ enum: HostStatus })
  @IsEnum(HostStatus)
  status!: HostStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNote?: string;

  @ApiProperty({ required: false, description: 'Internal admin-only note' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNote?: string;
}

export class SetHostVerificationDto {
  @ApiProperty({ enum: HostVerificationStatus })
  @IsEnum(HostVerificationStatus)
  verificationStatus!: HostVerificationStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNote?: string;
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @Get('users')
  users(@Query('status') status?: UserStatus, @Query('q') q?: string) {
    return this.admin.listUsers(status, q);
  }

  @Get('users/:id')
  user(@Param('id') id: string) {
    return this.admin.getUser(id);
  }

  @Patch('users/:id/status')
  setStatus(
    @CurrentUser() actor: { userId: string },
    @Param('id') id: string,
    @Body() body: SetUserStatusDto,
  ) {
    return this.admin.setUserStatus(actor.userId, id, body.status);
  }

  @Get('hosts')
  hosts(@Query('status') status?: HostStatus) {
    return this.admin.listHosts(status);
  }

  @Get('hosts/:id')
  host(@Param('id') id: string) {
    return this.admin.getHost(id);
  }

  @Patch('hosts/:id/status')
  setHost(
    @CurrentUser() actor: { userId: string },
    @Param('id') id: string,
    @Body() body: SetHostStatusDto,
  ) {
    return this.admin.setHostStatus(
      actor.userId,
      id,
      body.status,
      body.reviewNote,
      body.internalNote,
    );
  }

  @Patch('hosts/:id/verification')
  setHostVerification(
    @CurrentUser() actor: { userId: string },
    @Param('id') id: string,
    @Body() body: SetHostVerificationDto,
  ) {
    return this.admin.setHostVerification(
      actor.userId,
      id,
      body.verificationStatus,
      body.internalNote,
    );
  }

  @Get('calls')
  calls() {
    return this.admin.listCalls();
  }

  @Get('calls/:id')
  call(@Param('id') id: string) {
    return this.admin.getCall(id);
  }

  @Get('payments')
  payments() {
    return this.admin.listPayments();
  }

  @Get('payouts')
  payouts() {
    return this.admin.listPayouts();
  }

  @Patch('payouts/:id')
  setPayout(
    @CurrentUser() actor: { userId: string },
    @Param('id') id: string,
    @Body() body: ResolvePayoutDto,
  ) {
    return this.admin.setPayoutStatus(actor.userId, id, body.status);
  }

  @Get('reports')
  reports(@Query('status') status?: ReportStatus) {
    return this.admin.listReports(status);
  }

  @Patch('reports/:id')
  resolve(
    @CurrentUser() actor: { userId: string },
    @Param('id') id: string,
    @Body() body: ResolveReportDto,
  ) {
    return this.admin.resolveReport(actor.userId, id, body.status);
  }

  @Post('wallet/adjustments')
  adjust(
    @CurrentUser() actor: { userId: string },
    @Body() body: WalletAdjustmentDto,
  ) {
    return this.admin.adjustWallet(
      actor.userId,
      body.userId,
      body.amountCents,
      body.reason,
    );
  }

  @Get('users/:id/wallet/reconcile')
  reconcile(@Param('id') id: string) {
    return this.admin.reconcileWallet(id);
  }

  @Post('calls/:id/refund')
  refundCall(
    @CurrentUser() actor: { userId: string },
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.admin.refundCall(actor.userId, id, body?.reason);
  }

  @Get('audit-logs')
  auditLogs(
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
  ) {
    return this.admin.listAuditLogs(targetType, targetId);
  }
}
