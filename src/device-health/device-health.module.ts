import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { DeviceHealthController } from './device-health.controller';
import { DeviceLinkHealth } from './entities/device-link-health.entity';
import { DeviceHealthService } from './services/device-health.service';

/**
 * Device and connectivity health (task P4-08).
 *
 * Written by the shift runner from the window it already has, read by anybody who can
 * see the machine. It imports the equipment profile entity rather than the equipment
 * module, for the plant id it copies onto a row and nothing else.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DeviceLinkHealth, EquipmentProfile])],
  controllers: [DeviceHealthController],
  providers: [DeviceHealthService],
  exports: [DeviceHealthService],
})
export class DeviceHealthModule {}
