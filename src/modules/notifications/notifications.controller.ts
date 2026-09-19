import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

export class RegisterDeviceDto {
  @ApiProperty()
  @IsString()
  @MinLength(8)
  token!: string;

  @ApiProperty({ enum: ['ios', 'android'] })
  @IsIn(['ios', 'android'])
  platform!: string;
}

export class NotificationPreferencesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  incomingCall?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  chatMessage?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  payment?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  wallet?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  host?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  payout?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  system?: boolean;
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: { userId: string }) {
    return this.notifications.list(user.userId);
  }

  @Get('preferences')
  getPreferences(@CurrentUser() user: { userId: string }) {
    return this.notifications.getPreferences(user.userId);
  }

  @Patch('preferences')
  updatePreferences(
    @CurrentUser() user: { userId: string },
    @Body() body: NotificationPreferencesDto,
  ) {
    return this.notifications.updatePreferences(user.userId, body);
  }

  @Post('read-all')
  readAll(@CurrentUser() user: { userId: string }) {
    return this.notifications.markAllRead(user.userId);
  }

  @Post(':id/read')
  readOne(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.notifications.markRead(user.userId, id);
  }

  @Post('devices')
  register(
    @CurrentUser() user: { userId: string },
    @Body() body: RegisterDeviceDto,
  ) {
    return this.notifications.registerDevice(
      user.userId,
      body.token,
      body.platform,
    );
  }

  @Delete('devices/:token')
  @HttpCode(204)
  remove(
    @CurrentUser() user: { userId: string },
    @Param('token') token: string,
  ) {
    return this.notifications.removeDevice(user.userId, token);
  }
}
