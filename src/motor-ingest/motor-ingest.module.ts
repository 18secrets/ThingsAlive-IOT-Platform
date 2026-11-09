import { Module } from '@nestjs/common';
import { AlertModule } from '../alert/alert.module';
import { MotorIngestController } from './motor-ingest.controller';
import { MotorIngestService } from './motor-ingest.service';
import { MotorTelemetryScheduler } from './motor-telemetry.scheduler';

@Module({
  imports: [AlertModule],
  controllers: [MotorIngestController],
  providers: [MotorIngestService, MotorTelemetryScheduler],
  exports: [MotorIngestService],
})
export class MotorIngestModule {}
