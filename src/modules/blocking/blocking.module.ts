import { Module } from '@nestjs/common';
import { BlockingController } from './blocking.controller';
import { BlockingService } from './blocking.service';

@Module({
  controllers: [BlockingController],
  providers: [BlockingService],
  exports: [BlockingService],
})
export class BlockingModule {}
