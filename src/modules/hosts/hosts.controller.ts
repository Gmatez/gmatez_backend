import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { HostAvailability } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { HostsService } from './hosts.service';

export class HostAgreementAcceptanceDto {
  @ApiProperty({
    enum: ['HOST_GUIDELINES', 'TERMS_OF_SERVICE', 'PRIVACY_POLICY'],
  })
  @IsString()
  @IsIn(['HOST_GUIDELINES', 'TERMS_OF_SERVICE', 'PRIVACY_POLICY'])
  agreementType!: string;

  @ApiProperty({ example: '1.0' })
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  version!: string;
}

export class HostApplyDto {
  @ApiProperty()
  @IsString()
  @MinLength(8)
  @MaxLength(500)
  applicationBio!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @IsString({ each: true })
  languages!: string[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  interests!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  voiceEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  videoEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  voiceRatePerMinuteCents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  videoRatePerMinuteCents?: number;

  @ApiProperty({ type: [HostAgreementAcceptanceDto] })
  @IsArray()
  @ArrayMinSize(3)
  @ValidateNested({ each: true })
  @Type(() => HostAgreementAcceptanceDto)
  acceptedAgreements!: HostAgreementAcceptanceDto[];
}

export class HostPatchDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  voiceEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  videoEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  voiceRatePerMinuteCents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  videoRatePerMinuteCents?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  languages?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  interests?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  applicationBio?: string;
}

export class HostAvailabilityDto {
  @ApiProperty({ enum: ['OFFLINE', 'ONLINE', 'PAUSED'] })
  @IsIn(['OFFLINE', 'ONLINE', 'PAUSED'])
  availability!: Exclude<HostAvailability, 'BUSY'>;
}

@ApiTags('hosts')
@ApiBearerAuth()
@Controller('hosts')
export class HostsController {
  constructor(private readonly hosts: HostsService) {}

  @Get('me')
  me(@CurrentUser() user: { userId: string }) {
    return this.hosts.getMe(user.userId);
  }

  @Get('me/completeness')
  completeness(@CurrentUser() user: { userId: string }) {
    return this.hosts.getCompleteness(user.userId);
  }

  @Get('me/dashboard')
  dashboard(@CurrentUser() user: { userId: string }) {
    return this.hosts.dashboard(user.userId);
  }

  @Post('applications')
  apply(@CurrentUser() user: { userId: string }, @Body() body: HostApplyDto) {
    return this.hosts.apply(user.userId, body);
  }

  @Patch('me')
  patch(@CurrentUser() user: { userId: string }, @Body() body: HostPatchDto) {
    return this.hosts.patchMe(user.userId, body);
  }

  @Post('me/availability')
  availability(
    @CurrentUser() user: { userId: string },
    @Body() body: HostAvailabilityDto,
  ) {
    return this.hosts.setAvailability(user.userId, body.availability);
  }
}
