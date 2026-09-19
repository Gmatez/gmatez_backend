import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { HostCompletenessService } from './host-completeness.service';
import { HostsController } from './hosts.controller';
import { HostsService } from './hosts.service';

@Module({
  imports: [NotificationsModule],
  controllers: [HostsController],
  providers: [HostsService, HostCompletenessService],
  exports: [HostsService, HostCompletenessService],
})
export class HostsModule {}
