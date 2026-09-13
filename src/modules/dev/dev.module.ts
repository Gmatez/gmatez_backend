import { Module } from '@nestjs/common';
import { CallingModule } from '../calling/calling.module';
import { PaymentsModule } from '../payments/payments.module';
import { DevController } from './dev.controller';

@Module({
  imports: [PaymentsModule, CallingModule],
  controllers: [DevController],
})
export class DevModule {}
