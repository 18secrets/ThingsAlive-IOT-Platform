import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EquipmentClassProfile } from '../catalog/entities/equipment-class-profile.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { EquipmentServiceRecord } from './entities/equipment-service-record.entity';
import { ServiceController } from './service.controller';
import { ServiceForecastService } from './services/service-forecast.service';

/**
 * Hour-based service prediction (task P4-07).
 *
 * Reads four things and owns one. The interval comes from the equipment register or
 * the catalog, the meter from telemetry, the rate from the duty-cycle rows — and the
 * service history is this module's own, because nothing upstream records when a
 * machine was last serviced.
 */
@Module({
  imports: [TypeOrmModule.forFeature([
    EquipmentServiceRecord, EquipmentProfile, EquipmentClassProfile,
  ])],
  controllers: [ServiceController],
  providers: [ServiceForecastService],
  exports: [ServiceForecastService],
})
export class ServiceModule {}
