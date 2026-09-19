import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PayoutsService } from './payouts.service';

export class CreatePayoutDto {
  @ApiProperty({ minimum: 500 })
  @IsInt()
  @Min(500)
  amountCents!: number;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  idempotencyKey!: string;
}

export class UpsertDestinationDto {
  @ApiProperty({ enum: ['BANK', 'UPI', 'PAYPAL', 'OTHER'] })
  @IsString()
  type!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  label?: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  details!: Record<string, unknown>;
}

@ApiTags('payouts')
@ApiBearerAuth()
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Post()
  request(
    @CurrentUser() user: { userId: string },
    @Body() body: CreatePayoutDto,
  ) {
    return this.payouts.request(
      user.userId,
      body.amountCents,
      body.idempotencyKey,
    );
  }

  @Get()
  list(@CurrentUser() user: { userId: string }) {
    return this.payouts.list(user.userId);
  }

  @Get('destinations')
  listDestinations(@CurrentUser() user: { userId: string }) {
    return this.payouts.listDestinations(user.userId);
  }

  @Post('destinations')
  upsertDestination(
    @CurrentUser() user: { userId: string },
    @Body() body: UpsertDestinationDto,
  ) {
    return this.payouts.upsertDestination(user.userId, body);
  }
}
