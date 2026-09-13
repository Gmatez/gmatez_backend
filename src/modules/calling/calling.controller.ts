import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import type { FastifyRequest } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CursorPaginationQueryDto } from '../../common/dto/pagination.dto';
import { CallingService } from './calling.service';

export class CreateCallDto {
  @ApiProperty()
  @IsUUID()
  calleeId!: string;

  @ApiPropertyOptional({ enum: ['VOICE', 'VIDEO'] })
  @IsOptional()
  @IsIn(['VOICE', 'VIDEO'])
  callType?: 'VOICE' | 'VIDEO';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(8)
  idempotencyKey?: string;
}

@ApiTags('calling')
@Controller('calls')
export class CallingController {
  constructor(private readonly calling: CallingService) {}

  @Public()
  @Post('provider/callback')
  @ApiHeader({ name: 'x-provider-signature', required: true })
  callback(
    @Req() request: FastifyRequest,
    @Headers('x-provider-signature') signature: string | undefined,
  ) {
    const raw =
      (request as FastifyRequest & { rawBody?: string }).rawBody ??
      JSON.stringify(request.body ?? {});
    return this.calling.handleProviderCallback(
      typeof raw === 'string' ? raw : String(raw),
      signature,
    );
  }

  @ApiBearerAuth()
  @Post()
  create(@CurrentUser() user: { userId: string }, @Body() body: CreateCallDto) {
    return this.calling.createCall(
      user.userId,
      body.calleeId,
      body.idempotencyKey,
      body.callType === 'VIDEO' ? 'VIDEO' : 'VOICE',
    );
  }

  @ApiBearerAuth()
  @Get()
  list(
    @CurrentUser() user: { userId: string },
    @Query() query: CursorPaginationQueryDto,
  ) {
    return this.calling.listHistory(user.userId, query.limit, query.cursor);
  }

  @ApiBearerAuth()
  @Get(':id')
  getOne(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.calling.getOwn(id, user.userId);
  }

  @ApiBearerAuth()
  @Post(':id/accept')
  accept(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.calling.accept(id, user.userId);
  }

  @ApiBearerAuth()
  @Post(':id/reject')
  reject(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.calling.reject(id, user.userId);
  }

  @ApiBearerAuth()
  @Post(':id/cancel')
  cancel(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.calling.cancel(id, user.userId);
  }

  @ApiBearerAuth()
  @Post(':id/end')
  end(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.calling.end(id, user.userId);
  }

  @ApiBearerAuth()
  @HttpCode(204)
  @Post(':id/heartbeat')
  heartbeat(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.calling.heartbeat(id, user.userId);
  }
}
