import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CalibrationVersion } from './entities/calibration-version.entity';
import { EquipmentParameter } from './entities/equipment-parameter.entity';
import { SensorInstance } from './entities/sensor-instance.entity';
import { SignalBindingVersion } from './entities/signal-binding-version.entity';
import { SignalBindingController } from './signal-binding.controller';
import { SignalBindingService } from './services/signal-binding.service';

/**
 * Coverage, discovery and resolve-at-event-time (task Q08S slice 2).
 *
 * `EquipmentClassSensorRequirement`, `EquipmentProfile`, `DeviceInventory`,
 * `ToolMapping`, `Sensor`, `SensorRoleCapability` and `SensorMapProjection` are
 * read directly off the shared `DataSource` inside `SignalBindingService` rather
 * than through `TypeOrmModule.forFeature` here — the same pattern
 * `CatalogImportModule` already uses, for the same reason: they are not this
 * module's tables to own.
 */
@Module({
  imports: [TypeOrmModule.forFeature([
    SignalBindingVersion, SensorInstance, CalibrationVersion, EquipmentParameter,
  ])],
  controllers: [SignalBindingController],
  providers: [SignalBindingService],
  exports: [SignalBindingService],
})
export class SignalBindingModule {}
