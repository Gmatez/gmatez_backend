import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { FastifyRequest } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PaymentsService } from './payments.service';

export class CreatePaymentIntentDto {
  @ApiProperty({ required: false, minimum: 100 })
  @ValidateIf((body: CreatePaymentIntentDto) => !body.rechargePlanId)
  @IsInt()
  @Min(100)
  @Max(1_000_000)
  amountCents?: number;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  idempotencyKey!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  rechargePlanId?: string;
}

export class VerifyRazorpayPaymentDto {
  @ApiProperty()
  @IsString()
  @MinLength(4)
  razorpayOrderId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(4)
  razorpayPaymentId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  razorpaySignature!: string;
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
      body.rechargePlanId,
    );
  }

  @ApiBearerAuth()
  @Post(':id/verify')
  verify(
    @CurrentUser() user: { userId: string },
    @Param('id') id: string,
    @Body() body: VerifyRazorpayPaymentDto,
  ) {
    return this.payments.verifyCheckout(user.userId, id, {
      orderId: body.razorpayOrderId,
      paymentId: body.razorpayPaymentId,
      signature: body.razorpaySignature,
    });
  }

  @ApiBearerAuth()
  @Post(':id/abandon')
  abandon(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.payments.abandon(user.userId, id);
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
    return this.payments.getOwnView(user.userId, id);
  }

  @Public()
  @Post('webhooks/:provider')
  @ApiHeader({ name: 'x-provider-signature', required: false })
  @ApiHeader({ name: 'x-razorpay-signature', required: false })
  handleWebhook(
    @Param('provider') providerName: string,
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers('x-provider-signature') signature: string | undefined,
    @Headers('x-razorpay-signature') razorpaySignature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
  ) {
    if (providerName === 'razorpay') {
      if (!request.rawBody) {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED,
          'Raw body required for Razorpay webhook verification',
          HttpStatus.BAD_REQUEST,
        );
      }
      const body = Buffer.isBuffer(request.rawBody)
        ? request.rawBody.toString('utf8')
        : String(request.rawBody);
      return this.payments.handleRazorpayWebhook(
        body,
        razorpaySignature,
        eventId,
      );
    }
    const raw = request.rawBody ?? JSON.stringify(request.body ?? {});
    return this.payments.handleWebhook(rawBody(raw), signature);
  }
}

function rawBody(raw: string | Buffer): string {
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}
