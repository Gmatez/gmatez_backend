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
import { IsUUID } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BlockingService } from './blocking.service';

export class BlockUserDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;
}

@ApiTags('blocking')
@ApiBearerAuth()
@Controller('blocks')
export class BlockingController {
  constructor(private readonly blocking: BlockingService) {}

  @Get()
  list(@CurrentUser() user: { userId: string }) {
    return this.blocking.list(user.userId);
  }

  @Post()
  block(@CurrentUser() user: { userId: string }, @Body() body: BlockUserDto) {
    return this.blocking.block(user.userId, body.userId);
  }

  @Delete(':userId')
  @HttpCode(204)
  unblock(
    @CurrentUser() user: { userId: string },
    @Param('userId') userId: string,
  ) {
    return this.blocking.unblock(user.userId, userId);
  }
}
