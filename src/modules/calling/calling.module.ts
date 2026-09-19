import { Module } from '@nestjs/common';
import { BlockingModule } from '../blocking/blocking.module';
import { ChatModule } from '../chat/chat.module';
import { HostsModule } from '../hosts/hosts.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WalletModule } from '../wallet/wallet.module';
import { CallingController } from './calling.controller';
import { CallingGateway } from './calling.gateway';
import { CallingService } from './calling.service';

@Module({
  imports: [
    WalletModule,
    BlockingModule,
    NotificationsModule,
    ChatModule,
    HostsModule,
  ],
  controllers: [CallingController],
  providers: [CallingService, CallingGateway],
  exports: [CallingService],
})
export class CallingModule {}
