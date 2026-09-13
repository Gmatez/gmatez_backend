import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';
import type { FastifyRequest } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';

export class CreatePaymentIntentDto {
  @ApiProperty({ minimum: 100 })
  @IsInt()
  @Min(100)
  @Max(1_000_000)
  amountCents!: number;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  idempotencyKey!: string;
}

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @ApiBearerAuth()
  @Post('intents')
  createIntent(
    @CurrentUser() user: { userId: string },
    @Body() body: CreatePaymentIntentDto,
  ) {
    return this.payments.createIntent(
      user.userId,
      body.amountCents,
      body.idempotencyKey,
    );
  }

  @ApiBearerAuth()
  @Post(':id/sandbox-confirm')
  sandboxConfirm(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
  ) {
    return this.payments.sandboxConfirm(user.userId, id);
  }

  @ApiBearerAuth()
  @Get(':id')
  getOne(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.payments.getOwn(user.userId, id);
  }

  @Public()
  @Post('webhooks/:provider')
  @ApiHeader({ name: 'x-provider-signature', required: true })
  handleWebhook(
    @Req() request: FastifyRequest,
    @Headers('x-provider-signature') signature: string | undefined,
  ) {
    const raw =
      (request as FastifyRequest & { rawBody?: string }).rawBody ??
      JSON.stringify(request.body ?? {});
    return this.payments.handleWebhook(rawBody(raw), signature);
  }
}

function rawBody(raw: string | Buffer): string {
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}
