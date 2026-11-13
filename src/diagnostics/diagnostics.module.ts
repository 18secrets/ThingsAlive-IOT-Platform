import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DtcMasterCatalog } from './entities/dtc-master.entity';
import { DeviceDtcEpisode } from './entities/device-dtc-episode.entity';
import { DtcEpisodeService } from './services/dtc-episode.service';
import { DiagnosticsController } from './diagnostics.controller';
import { LegacyModule } from '../legacy/legacy.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DtcMasterCatalog, DeviceDtcEpisode]),
    LegacyModule,
  ],
  controllers: [DiagnosticsController],
  providers: [DtcEpisodeService],
  exports: [DtcEpisodeService],
})
export class DiagnosticsModule {}
