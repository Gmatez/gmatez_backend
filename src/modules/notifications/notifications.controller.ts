import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, MinLength } from 'class-validator';
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

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: { userId: string }) {
    return this.notifications.list(user.userId);
  }

  @Post('read-all')
  readAll(@CurrentUser() user: { userId: string }) {
    return this.notifications.markAllRead(user.userId);
  }

  @Post(':id/read')
  readOne(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
  ) {
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
