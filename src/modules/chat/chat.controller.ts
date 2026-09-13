import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CursorPaginationQueryDto } from '../../common/dto/pagination.dto';
import { ChatService } from './chat.service';

export class OpenConversationDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;
}

export class SendMessageDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  idempotencyKey!: string;
}

@ApiTags('chat')
@ApiBearerAuth()
@Controller('conversations')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  open(
    @CurrentUser() user: { userId: string },
    @Body() body: OpenConversationDto,
  ) {
    return this.chat.openConversation(user.userId, body.userId);
  }

  @Get()
  list(
    @CurrentUser() user: { userId: string },
    @Query() query: CursorPaginationQueryDto,
  ) {
    return this.chat.listConversations(user.userId, query.limit, query.cursor);
  }

  @Get(':id/messages')
  messages(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
    @Query() query: CursorPaginationQueryDto,
  ) {
    return this.chat.listMessages(user.userId, id, query.limit, query.cursor);
  }

  @Post(':id/messages')
  send(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
    @Body() body: SendMessageDto,
  ) {
    return this.chat.sendMessage(
      user.userId,
      id,
      body.body,
      body.idempotencyKey,
    );
  }

  @Post(':id/read')
  read(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.chat.markRead(user.userId, id);
  }
}
