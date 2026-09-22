import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { HostsModule } from '../hosts/hosts.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { CallingModule } from '../calling/calling.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminController } from './admin.controller';
import { AdminReadService } from './admin-read.service';
import { AdminService } from './admin.service';

@Module({
  imports: [
    WalletModule,
    PayoutsModule,
    HostsModule,
    CallingModule,
    NotificationsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminReadService],
})
export class AdminModule {}
