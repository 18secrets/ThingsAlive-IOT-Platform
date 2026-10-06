import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Sensor } from './entities/sensor.entity';
import { SensorCategory } from './entities/sensor-category.entity';
import { ToolMapping } from './entities/tool-mapping.entity';
import { SignalState } from './entities/signal-state.entity';
import { DeviceCatalogController } from './device-catalog.controller';
import { DeviceCatalogService } from './services/device-catalog.service';
import { SignalStateService } from './services/signal-state.service';
import { SignalStateController } from './signal-state.controller';

/**
 * Sensors, sensor categories and tool mappings: Master Admin's own reference data for
 * wiring a device before it exists. Platform-owned, registered directly like
 * `CatalogModule` registers `EquipmentClassProfile` — no `ScopedRepository`, because
 * none of these rows have a tenant to scope by.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SensorCategory, Sensor, ToolMapping, SignalState])],
  controllers: [DeviceCatalogController, SignalStateController],
  providers: [DeviceCatalogService, SignalStateService],
  exports: [DeviceCatalogService, SignalStateService],
})
export class DeviceCatalogModule {}
