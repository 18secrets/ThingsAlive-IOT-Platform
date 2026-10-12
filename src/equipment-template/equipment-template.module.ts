import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientEquipmentTemplate } from './entities/client-equipment-template.entity';
import { EquipmentTemplate } from './entities/equipment-template.entity';
import { ClientEquipmentTemplateController } from './client-equipment-template.controller';
import { EquipmentTemplateController } from './equipment-template.controller';
import { ClientEquipmentTemplateService } from './services/client-equipment-template.service';
import { EquipmentTemplateService } from './services/equipment-template.service';

@Module({
  imports: [TypeOrmModule.forFeature([EquipmentTemplate, ClientEquipmentTemplate])],
  controllers: [EquipmentTemplateController, ClientEquipmentTemplateController],
  providers: [EquipmentTemplateService, ClientEquipmentTemplateService],
})
export class EquipmentTemplateModule {}
