import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceProjection } from './entities/device-projection.entity';
import { EquipmentProjection } from './entities/equipment-projection.entity';
import { ProjectionRejection } from './entities/projection-rejection.entity';
import { SensorMapProjection } from './entities/sensor-map-projection.entity';
import { TenantMap } from './entities/tenant-map.entity';
import { ProjectionService } from './services/projection.service';
import { TelemetryReading } from '../telemetry/telemetry-reading.entity';
import { TelemetryService } from '../telemetry/telemetry.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EquipmentProjection, DeviceProjection, SensorMapProjection,
      TenantMap, ProjectionRejection, TelemetryReading,
    ]),
  ],
  providers: [ProjectionService, TelemetryService],
  exports: [ProjectionService, TelemetryService],
})
export class ProjectionModule {}
