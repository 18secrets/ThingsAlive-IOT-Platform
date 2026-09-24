import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Sensor } from './entities/sensor.entity';
import { SensorCategory } from './entities/sensor-category.entity';
import { ToolMapping } from './entities/tool-mapping.entity';
import { DeviceCatalogController } from './device-catalog.controller';
import { DeviceCatalogService } from './services/device-catalog.service';

/**
 * Sensors, sensor categories and tool mappings: Master Admin's own reference data for
 * wiring a device before it exists. Platform-owned, registered directly like
 * `CatalogModule` registers `EquipmentClassProfile` — no `ScopedRepository`, because
 * none of these rows have a tenant to scope by.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SensorCategory, Sensor, ToolMapping])],
  controllers: [DeviceCatalogController],
  providers: [DeviceCatalogService],
  exports: [DeviceCatalogService],
})
export class DeviceCatalogModule {}
