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
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/public.decorator';
import { AdminReadService } from './admin-read.service';
import { AdminService } from './admin.service';

export class SetUserStatusDto {
  @ApiProperty({ enum: UserStatus })
  @IsEnum(UserStatus)
  status!: UserStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class WalletAdjustmentDto {
  @ApiProperty()
  @IsUUID()
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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(80)
  idempotencyKey?: string;
}

export class ResolveReportDto {
  @ApiProperty({ enum: ReportStatus })
  @IsEnum(ReportStatus)
  status!: ReportStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ResolvePayoutDto {
  @ApiProperty({ enum: PayoutStatus })
  @IsEnum(PayoutStatus)
  status!: PayoutStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  failureReason?: string;
}

export class RefundCallDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class SendNotificationDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  title!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  body!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deepLink?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  type?: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  @MaxLength(80)
  idempotencyKey!: string;
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
  constructor(
    private readonly admin: AdminService,
    private readonly read: AdminReadService,
  ) {}

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @Get('dashboard')
  dashboard() {
    return this.read.dashboard();
  }

  @Get('analytics')
  analytics(@Query('days') days?: string) {
    return this.read.analytics(days);
  }

  @Get('alerts')
  alerts() {
    return this.read.alerts();
  }

  @Get('search')
  search(@Query('q') q?: string) {
    return this.read.search(q);
  }

  @Get('system')
  system() {
    return this.read.systemStatus();
  }

  @Get('earnings')
  earnings() {
    return this.read.earnings();
  }

  @Get('wallets')
  wallets(@Query() query: Record<string, string | undefined>) {
    return this.read.listWallets(query);
  }

  @Get('users')
  users(@Query() query: Record<string, string | undefined>) {
    if (query.page) {
      return this.read.listUsers(query);
    }
    return this.admin.listUsers(query.status as UserStatus | undefined, query.q);
  }

  @Get('users/:id')
  user(@Param('id') id: string) {
    return this.admin.getUser(id);
  }

  @Get('users/:id/ledger')
  ledger(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.read.ledger(id, limit, cursor);
  }

  @Get('users/:id/blocks')
  blocks(@Param('id') id: string) {
    return this.read.blocks(id);
  }

  @Patch('users/:id/status')
  setStatus(
    @CurrentUser() actor: { userId: string },
    @Param('id') id: string,
    @Body() body: SetUserStatusDto,
  ) {
    return this.admin.setUserStatus(actor.userId, id, body.status, body.reason);
  }

  @Get('hosts')
  hosts(@Query() query: Record<string, string | undefined>) {
    if (
      query.page ||
      query.availability ||
      query.verificationStatus ||
      query.incomplete ||
      query.q
    ) {
      return this.read.listHosts(query);
    }
    return this.admin.listHosts(query.status as HostStatus | undefined);
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
  calls(@Query() query: Record<string, string | undefined>) {
    if (query.page || query.status || query.callType || query.settlement || query.q) {
      return this.read.listCalls(query);
    }
    return this.admin.listCalls();
  }

  @Get('calls/:id')
  call(@Param('id') id: string) {
    return this.read.getCall(id);
  }

  @Get('payments')
  payments(@Query() query: Record<string, string | undefined>) {
    if (query.page || query.status || query.provider || query.q) {
      return this.read.listPayments(query);
    }
    return this.admin.listPayments();
  }

  @Get('payments/:id')
  payment(@Param('id') id: string) {
    return this.read.getPayment(id);
  }

  @Get('payouts')
  payouts(@Query() query: Record<string, string | undefined>) {
    if (query.page || query.status || query.q) {
      return this.read.listPayouts(query);
    }
    return this.admin.listPayouts();
  }

  @Get('payouts/:id')
  payout(@Param('id') id: string) {
    return this.read.getPayout(id);
  }

  @Patch('payouts/:id')
  setPayout(
    @CurrentUser() actor: { userId: string },
    @Param('id') id: string,
    @Body() body: ResolvePayoutDto,
  ) {
    return this.admin.setPayoutStatus(
      actor.userId,
      id,
      body.status,
      body.failureReason,
    );
  }

  @Get('reports')
  reports(@Query() query: Record<string, string | undefined>) {
    if (query.page || query.reason || query.from) {
      return this.read.listReports(query);
    }
    return this.admin.listReports(query.status as ReportStatus | undefined);
  }

  @Get('reports/:id')
  report(@Param('id') id: string) {
    return this.read.getReport(id);
  }

  @Patch('reports/:id')
  resolve(
    @CurrentUser() actor: { userId: string },
    @Param('id') id: string,
    @Body() body: ResolveReportDto,
  ) {
    return this.admin.resolveReport(actor.userId, id, body.status, body.reason);
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
      body.idempotencyKey,
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
    @Body() body: RefundCallDto,
  ) {
    return this.admin.refundCall(actor.userId, id, body?.reason);
  }

  @Get('notifications')
  notifications(@Query() query: Record<string, string | undefined>) {
    return this.read.listNotifications(query);
  }

  @Post('notifications')
  sendNotification(
    @CurrentUser() actor: { userId: string },
    @Body() body: SendNotificationDto,
  ) {
    return this.admin.sendNotification(actor.userId, body);
  }

  @Get('devices')
  devices(@Query() query: Record<string, string | undefined>) {
    return this.read.listDevices(query);
  }

  @Get('audit-logs')
  auditLogs(@Query() query: Record<string, string | undefined>) {
    if (query.page || query.actorId || query.action || query.from) {
      return this.read.listAudit(query);
    }
    return this.admin.listAuditLogs(query.targetType, query.targetId);
  }
}
