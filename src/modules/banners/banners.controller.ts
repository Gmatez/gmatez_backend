import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/public.decorator';
import { BannersService } from './banners.service';

export class UpsertBannerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subtitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  ctaLabel?: string;

  @ApiPropertyOptional({ description: 'In-app path e.g. /wallet' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deepLink?: string;

  @ApiPropertyOptional({ enum: ['ALL', 'USER', 'HOST'] })
  @IsOptional()
  @IsString()
  audience?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endsAt?: string;
}

@ApiTags('banners')
@ApiBearerAuth()
@Controller()
export class BannersController {
  constructor(private readonly banners: BannersService) {}

  /** Active banners for the signed-in user’s home screen. */
  @Get('banners')
  listActive(@CurrentUser() user: { userId: string }) {
    return this.banners.listActiveForUser(user.userId);
  }

  @Roles('ADMIN')
  @Get('admin/banners')
  listAll() {
    return this.banners.listAll();
  }

  @Roles('ADMIN')
  @Post('admin/banners')
  create(
    @CurrentUser() actor: { userId: string },
    @Body() body: UpsertBannerDto,
  ) {
    return this.banners.create(actor.userId, body);
  }

  @Roles('ADMIN')
  @Patch('admin/banners/:id')
  update(
    @CurrentUser() actor: { userId: string },
    @Param('id') id: string,
    @Body() body: UpsertBannerDto,
  ) {
    return this.banners.update(actor.userId, id, body);
  }

  @Roles('ADMIN')
  @Delete('admin/banners/:id')
  remove(
    @CurrentUser() actor: { userId: string },
    @Param('id') id: string,
  ) {
    return this.banners.remove(actor.userId, id);
  }
}
