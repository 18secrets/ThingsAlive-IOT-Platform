import { Module } from '@nestjs/common';
import { ServiceRosterController } from './service-roster.controller';
import { ServiceRosterService } from './service-roster.service';

@Module({
  controllers: [ServiceRosterController],
  providers: [ServiceRosterService],
  exports: [ServiceRosterService],
})
export class ServiceRosterModule {}
