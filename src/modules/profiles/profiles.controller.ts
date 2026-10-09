import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Req,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Gender } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { FastifyRequest } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { HostDocumentsService } from '../hosts/host-documents.service';
import { ProfilesService } from './profiles.service';

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MinLength(2)
  @MaxLength(40)
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(280)
  bio?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2)
  @Matches(/^[A-Za-z]{2}$/)
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^[A-Za-z-]{2,16}$/)
  language?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, value) => value !== '' && value != null)
  @IsString()
  @MaxLength(2048)
  avatarUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDiscoverable?: boolean;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  ratePerMinuteCents?: number;
}

export class ProfileAvatarDto {
  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'image/webp'] })
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  mime!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  dataBase64!: string;
}

@ApiTags('profiles')
@ApiBearerAuth()
@Controller('profiles')
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly documents: HostDocumentsService,
  ) {}

  @Get('me')
  getMine(@CurrentUser() user: { userId: string }) {
    return this.profiles.getMine(user.userId);
  }

  @Patch('me')
  updateMine(
    @CurrentUser() user: { userId: string },
    @Body() body: UpdateProfileDto,
  ) {
    return this.profiles.updateMine(user.userId, body);
  }

  @Post('me/avatar')
  uploadAvatar(
    @CurrentUser() user: { userId: string },
    @Body() body: ProfileAvatarDto,
    @Req() request: FastifyRequest,
  ) {
    const forwarded = request.headers['x-forwarded-proto'];
    const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded) || 'https';
    const hostHeader = request.headers['x-forwarded-host'] || request.headers.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    const publicUrl = `${proto}://${host}/api/v1/profiles/${user.userId}/avatar?v=${Date.now()}`;
    return this.profiles.setAvatar(
      user.userId,
      body.mime,
      body.dataBase64,
      publicUrl,
    );
  }

  @Public()
  @Get(':userId/avatar')
  @Header('Cache-Control', 'public, max-age=300')
  async avatar(@Param('userId') userId: string) {
    const file = await this.documents.read(userId, 'avatar');
    return new StreamableFile(file.data, { type: file.mime });
  }
}
