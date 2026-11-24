import { Module } from '@nestjs/common';
import { AlertModule } from '../alert/alert.module';
import { MotorIngestController } from './motor-ingest.controller';
import { MotorIngestService } from './motor-ingest.service';
import { MotorReportsController } from './motor-reports.controller';
import { MotorReportsService } from './motor-reports.service';
import { MotorTelemetryScheduler } from './motor-telemetry.scheduler';

@Module({
  imports: [AlertModule],
  controllers: [MotorIngestController, MotorReportsController],
  providers: [MotorIngestService, MotorTelemetryScheduler, MotorReportsService],
  exports: [MotorIngestService],
})
export class MotorIngestModule {}
