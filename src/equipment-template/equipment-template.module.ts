import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EquipmentTemplate } from './entities/equipment-template.entity';
import { EquipmentTemplateController } from './equipment-template.controller';
import { EquipmentTemplateService } from './services/equipment-template.service';

@Module({
  imports: [TypeOrmModule.forFeature([EquipmentTemplate])],
  controllers: [EquipmentTemplateController],
  providers: [EquipmentTemplateService],
})
export class EquipmentTemplateModule {}
