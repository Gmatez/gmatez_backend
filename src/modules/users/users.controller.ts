import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: { userId: string }) {
    return this.users.getMe(user.userId);
  }

  @Post('me/heartbeat')
  @HttpCode(204)
  heartbeat(@CurrentUser() user: { userId: string }) {
    return this.users.heartbeat(user.userId);
  }

  @Delete('me')
  @HttpCode(204)
  deleteMe(@CurrentUser() user: { userId: string }) {
    return this.users.deleteMe(user.userId);
  }

  @Get(':id')
  getPublic(
    @CurrentUser() user: { userId: string },
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.users.getPublic(user.userId, id);
  }
}
