import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DtcMasterCatalog } from './entities/dtc-master.entity';
import { DeviceDtcEpisode } from './entities/device-dtc-episode.entity';
import { DtcPullWatermark } from './entities/dtc-pull-watermark.entity';
import { DtcEpisodeService } from './services/dtc-episode.service';
import { DtcSyncService } from './services/dtc-sync.service';
import { DtcSyncScheduler } from './services/dtc-sync.scheduler';
import { FaultHistoryPruneScheduler } from './services/fault-history-prune.scheduler';
import { DiagnosticsController } from './diagnostics.controller';
import { FaultCodeLibraryController } from './fault-code-library.controller';
import { FaultCodeTypeGrant } from './entities/fault-code-type-grant.entity';
import { MotorFaultCode } from './entities/motor-fault-code.entity';
import { FaultCodeLibraryService } from './services/fault-code-library.service';
import { LegacyModule } from '../legacy/legacy.module';
import { AlertModule } from '../alert/alert.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DtcMasterCatalog, DeviceDtcEpisode, DtcPullWatermark, MotorFaultCode, FaultCodeTypeGrant]),
    LegacyModule,
    AlertModule,
  ],
  controllers: [DiagnosticsController, FaultCodeLibraryController],
  providers: [DtcEpisodeService, DtcSyncService, DtcSyncScheduler, FaultHistoryPruneScheduler, FaultCodeLibraryService],
  exports: [DtcEpisodeService, DtcSyncService, FaultCodeLibraryService],
})
export class DiagnosticsModule {}
