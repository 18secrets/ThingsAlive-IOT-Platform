import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProjectionModule } from '../projection/projection.module';
import { LegacyFleetSyncController } from './legacy-fleet-sync.controller';
import { LegacyFleetSyncScheduler } from './legacy-fleet-sync.scheduler';
import { LegacyFleetSyncService } from './legacy-fleet-sync.service';
import { LegacyTelemetryReader } from './legacy-telemetry.reader';
import { initLegacyDataSource, LEGACY_DATA_SOURCE, legacyConfigFrom } from './legacy-source';

/**
 * The one place 2.0 touches the existing platform, and it only reads (task P1-110).
 *
 * The provider resolves to null when nothing is configured, which is the honest state
 * until a route and a read-only user exist: the reader reports that it has no
 * connection, every shift window stays owed, and the backlog is scored the moment one
 * appears rather than being lost while there was none.
 */
@Module({
  imports: [ProjectionModule],
  controllers: [LegacyFleetSyncController],
  providers: [
    {
      provide: LEGACY_DATA_SOURCE,
      useFactory: () => initLegacyDataSource(legacyConfigFrom(process.env)),
    },
    LegacyTelemetryReader,
    LegacyFleetSyncService,
    LegacyFleetSyncScheduler,
  ],
  exports: [LegacyTelemetryReader, LEGACY_DATA_SOURCE],
})
export class LegacyModule {
  constructor() {}

  static async close(ds: DataSource | null): Promise<void> {
    if (ds?.isInitialized) await ds.destroy();
  }
}
