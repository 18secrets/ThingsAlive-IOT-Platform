import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DtcMasterCatalog } from './entities/dtc-master.entity';
import { DeviceDtcEpisode } from './entities/device-dtc-episode.entity';
import { DtcPullWatermark } from './entities/dtc-pull-watermark.entity';
import { DtcEpisodeService } from './services/dtc-episode.service';
import { DtcSyncService } from './services/dtc-sync.service';
import { DtcSyncScheduler } from './services/dtc-sync.scheduler';
import { DiagnosticsController } from './diagnostics.controller';
import { LegacyModule } from '../legacy/legacy.module';
import { AlertModule } from '../alert/alert.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DtcMasterCatalog, DeviceDtcEpisode, DtcPullWatermark]),
    LegacyModule,
    AlertModule,
  ],
  controllers: [DiagnosticsController],
  providers: [DtcEpisodeService, DtcSyncService, DtcSyncScheduler],
  exports: [DtcEpisodeService, DtcSyncService],
})
export class DiagnosticsModule {}
