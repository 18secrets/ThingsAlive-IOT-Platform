import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { UtilizationShift } from './entities/utilization-shift.entity';
import { BreakdownEvent } from './entities/breakdown-event.entity';
import { OeeController } from './oee.controller';
import { AvailabilityService } from './services/availability.service';
import { OeeService } from './services/oee.service';
import { UtilizationService } from './services/utilization.service';
import { UtilizationController } from './utilization.controller';

/**
 * Duty cycle: measured by the shift runner, read by everybody (task P4-05).
 *
 * It imports the equipment profile entity rather than the equipment module, because
 * all it wants is the plant and class to copy onto a row. Importing the module would
 * put the shift runner one edge away from a cycle for the sake of two fields.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UtilizationShift, EquipmentProfile, BreakdownEvent])],
  controllers: [UtilizationController, OeeController],
  providers: [UtilizationService, AvailabilityService, OeeService],
  exports: [UtilizationService],
})
export class UtilizationModule {}
