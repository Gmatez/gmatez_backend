import { Body, Controller, Post } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Min } from 'class-validator';
import { AppConfigService } from '../../config/app-config';
import { Public } from '../../common/decorators/public.decorator';
import { MockCallingProvider } from '../../providers/calling/mock-calling.provider';
import { MockPaymentProvider } from '../../providers/payments/mock-payment.provider';
import { CallingService } from '../calling/calling.service';
import { PaymentsService } from '../payments/payments.service';
import { AppError, ErrorCodes } from '../../common/errors/app-error';

export class SimulatePaymentDto {
  @ApiProperty()
  @IsString()
  providerPaymentId!: string;

  @ApiProperty({ enum: ['succeeded', 'failed', 'cancelled'] })
  @IsIn(['succeeded', 'failed', 'cancelled'])
  status!: 'succeeded' | 'failed' | 'cancelled';

  @ApiProperty()
  @IsInt()
  @Min(1)
  amountCents!: number;
}

export class SimulateCallDto {
  @ApiProperty()
  @IsString()
  sessionId!: string;

  @ApiProperty()
  @IsString()
  type!: 'ringing' | 'connecting' | 'connected' | 'ended' | 'failed';
}

@ApiTags('dev')
@Controller('dev')
export class DevController {
  constructor(
    private readonly config: AppConfigService,
    private readonly payments: PaymentsService,
    private readonly calling: CallingService,
    private readonly mockPayments: MockPaymentProvider,
    private readonly mockCalling: MockCallingProvider,
  ) {}

  @Public()
  @Post('payments/simulate-webhook')
  simulatePayment(@Body() body: SimulatePaymentDto) {
    this.ensureDev();
    const payload = JSON.stringify({
      eventId: `evt_${Date.now()}`,
      providerPaymentId: body.providerPaymentId,
      status: body.status,
      amountCents: body.amountCents,
      currency: 'USD',
    });
    const signature = this.mockPayments.sign(payload);
    return this.payments.handleWebhook(payload, signature);
  }

  @Public()
  @Post('calling/simulate-callback')
  simulateCall(@Body() body: SimulateCallDto) {
    this.ensureDev();
    const payload = JSON.stringify({
      eventId: `cevt_${Date.now()}`,
      sessionId: body.sessionId,
      type: body.type,
    });
    const signature = this.mockCalling.sign(payload);
    return this.calling.handleProviderCallback(payload, signature);
  }

  private ensureDev(): void {
    if (this.config.isProduction) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Not found', 404);
    }
  }
}
