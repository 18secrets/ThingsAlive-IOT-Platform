import { Module } from '@nestjs/common';
import { TelemetryPartitionMaintenance } from './services/telemetry-partition-maintenance.service';
import { TelemetryPartitionScheduler } from './services/telemetry-partition-scheduler.service';

/**
 * Wiring only (task QPART1). `ensure_telemetry_partition` is a database function
 * reached through the raw `DataSource`, not a repository, so this needs no
 * `TypeOrmModule.forFeature` of its own.
 */
@Module({
  providers: [TelemetryPartitionMaintenance, TelemetryPartitionScheduler],
  exports: [TelemetryPartitionMaintenance],
})
export class TelemetryPartitionModule {}
