import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { HostCompletenessService } from './host-completeness.service';
import { HostsController } from './hosts.controller';
import { HostDocumentsService } from './host-documents.service';
import { HostsService } from './hosts.service';

@Module({
  imports: [NotificationsModule],
  controllers: [HostsController],
  providers: [HostsService, HostCompletenessService, HostDocumentsService],
  exports: [HostsService, HostCompletenessService, HostDocumentsService],
})
export class HostsModule {}
