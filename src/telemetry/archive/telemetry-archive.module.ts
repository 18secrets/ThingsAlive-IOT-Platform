import { Module } from '@nestjs/common';
import { ARCHIVE_STORAGE, archiveStorageFrom } from './archive-storage';
import { TelemetryArchiveController } from './telemetry-archive.controller';
import { TelemetryArchiveScheduler } from './telemetry-archive.scheduler';
import { TelemetryArchiveService } from './telemetry-archive.service';

/** Telemetry past 90 days, to Parquet and out of the database (task QARCH1, D14). */
@Module({
  controllers: [TelemetryArchiveController],
  providers: [
    { provide: ARCHIVE_STORAGE, useFactory: () => archiveStorageFrom(process.env) },
    TelemetryArchiveService, TelemetryArchiveScheduler,
  ],
  exports: [TelemetryArchiveService],
})
export class TelemetryArchiveModule {}
