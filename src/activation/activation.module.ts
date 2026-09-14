import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogModule } from '../catalog/catalog.module';
import { DomainEvent } from '../events/domain-event.entity';
import { ActivationController } from './activation.controller';
import { EquipmentScenario } from './entities/equipment-scenario.entity';
import { ScenarioActivationEvent } from './entities/scenario-activation-event.entity';
import { ActivationHistoryService } from './services/activation-history.service';
import { ActivationService } from './services/activation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([EquipmentScenario, ScenarioActivationEvent, DomainEvent]),
    // For the recommendation engine: activation asks it whether the asset can run the
    // thing before promising the customer that it will.
    CatalogModule,
  ],
  controllers: [ActivationController],
  providers: [ActivationService, ActivationHistoryService],
  exports: [ActivationService],
})
export class ActivationModule {}
