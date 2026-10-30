import { Module } from '@nestjs/common';
import { CallingModule } from '../calling/calling.module';
import { HostsModule } from '../hosts/hosts.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [HostsModule, CallingModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
