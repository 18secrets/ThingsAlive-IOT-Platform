import { Module } from '@nestjs/common';
import { MotorIngestController, MotorLoggerKeyController } from './motor-ingest.controller';
import { MotorIngestService } from './motor-ingest.service';

@Module({
  controllers: [MotorIngestController, MotorLoggerKeyController],
  providers: [MotorIngestService],
})
export class MotorIngestModule {}
