import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MinLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/public.decorator';
import { AnalyticsService } from './analytics.service';

export class IngestEventDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  eventType!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;
}

@ApiTags('analytics')
@ApiBearerAuth()
@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Post('analytics/events')
  ingest(
    @CurrentUser() user: { userId: string },
    @Body() body: IngestEventDto,
  ) {
    return this.analytics.ingest(user.userId, body.eventType, body.properties);
  }

  @Roles('ADMIN')
  @Get('admin/analytics/overview')
  summary() {
    return this.analytics.adminSummary();
  }
}
