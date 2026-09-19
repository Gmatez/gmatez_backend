import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CursorPaginationQueryDto } from '../../common/dto/pagination.dto';
import { DiscoveryService } from './discovery.service';

export class DiscoveryFeedQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^[A-Za-z-]{2,16}$/)
  language?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === true || value === 'true' || value === '1') {
      return true;
    }
    if (
      value === false ||
      value === 'false' ||
      value === '0' ||
      value == null
    ) {
      return false;
    }
    return value;
  })
  @IsBoolean()
  online?: boolean;

  @ApiPropertyOptional({ enum: ['VOICE', 'VIDEO'] })
  @IsOptional()
  @IsIn(['VOICE', 'VIDEO'])
  callType?: 'VOICE' | 'VIDEO';
}

export class SearchQueryDto extends DiscoveryFeedQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  q?: string;
}

@ApiTags('discovery')
@ApiBearerAuth()
@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get('feed')
  feed(
    @CurrentUser() user: { userId: string },
    @Query() query: DiscoveryFeedQueryDto,
  ) {
    return this.discovery.feed(user.userId, {
      limit: query.limit,
      cursor: query.cursor,
      language: query.language,
      onlineOnly: query.online === true,
      callType: query.callType,
    });
  }

  @Get('search')
  search(
    @CurrentUser() user: { userId: string },
    @Query() query: SearchQueryDto,
  ) {
    return this.discovery.search(user.userId, {
      limit: query.limit,
      cursor: query.cursor,
      q: query.q,
      language: query.language,
      onlineOnly: query.online === true,
      callType: query.callType,
    });
  }
}
