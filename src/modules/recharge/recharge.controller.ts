import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public, Roles } from '../../common/decorators/public.decorator';
import { RechargeInput, RechargeService } from './recharge.service';

class RechargeFieldsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  priceMinor?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  walletCreditMinor?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  bonusMinor?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}

export class CreateRechargeDto
  extends RechargeFieldsDto
  implements RechargeInput
{
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  declare priceMinor: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  declare walletCreditMinor: number;
}

export class UpdateRechargeDto extends RechargeFieldsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;
}

@ApiTags('recharge')
@ApiBearerAuth()
@Controller()
export class RechargeController {
  constructor(private readonly recharge: RechargeService) {}

  @Public()
  @Get('recharge-plans')
  listActive() {
    return this.recharge.listActive();
  }

  @Roles('ADMIN')
  @Get('admin/recharge-plans')
  listAll() {
    return this.recharge.listAll();
  }

  @Roles('ADMIN')
  @Post('admin/recharge-plans')
  create(
    @CurrentUser() actor: { userId: string },
    @Body() body: CreateRechargeDto,
  ) {
    return this.recharge.create(actor.userId, body);
  }

  @Roles('ADMIN')
  @Patch('admin/recharge-plans/:id')
  update(
    @CurrentUser() actor: { userId: string },
    @Param('id') id: string,
    @Body() body: UpdateRechargeDto,
  ) {
    return this.recharge.update(actor.userId, id, body);
  }

  @Roles('ADMIN')
  @Delete('admin/recharge-plans/:id')
  remove(@CurrentUser() actor: { userId: string }, @Param('id') id: string) {
    return this.recharge.remove(actor.userId, id);
  }
}
