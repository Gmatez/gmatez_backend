import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { HostsModule } from '../hosts/hosts.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [WalletModule, PayoutsModule, HostsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
