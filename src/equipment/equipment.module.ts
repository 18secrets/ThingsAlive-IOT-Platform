import { ActivationModule } from '../activation/activation.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EquipmentPlacementEvent } from './entities/equipment-placement-event.entity';
import { Plant } from './entities/plant.entity';
import { EquipmentProfile } from './equipment-profile.entity';
import { EquipmentController } from './equipment.controller';
import { EquipmentService } from './services/equipment.service';
import { PlantService } from './services/plant.service';

@Module({
  imports: [TypeOrmModule.forFeature([EquipmentProfile, Plant, EquipmentPlacementEvent]), ActivationModule],
  controllers: [EquipmentController],
  providers: [EquipmentService, PlantService],
  exports: [EquipmentService, PlantService],
})
export class EquipmentModule {}
