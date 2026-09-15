import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { CatalogController } from './catalog.controller';
import { ClientCatalogEntitlement } from './entities/client-catalog-entitlement.entity';
import { EquipmentClassProfile } from './entities/equipment-class-profile.entity';
import { ScenarioDefinition } from './entities/scenario-definition.entity';
import { SignalAlias } from './entities/signal-alias.entity';
import { AlertRuleTemplate } from './entities/alert-rule-template.entity';
import { ClientCatalogModule } from '../client-catalog/client-catalog.module';
import { CatalogAuthoringService } from './services/catalog-authoring.service';
import { CatalogService } from './services/catalog.service';
import { EntitlementService } from './services/entitlement.service';
import { RecommendationService } from './services/recommendation.service';

/**
 * The catalog tables are platform-owned and registered with TypeORM directly rather
 * than through `provideScoped`. That is not an oversight: a scoped repository narrows
 * by tenant, and these rows have no tenant. What narrows them is the entitlement
 * join, which lives in CatalogService and is the only place a tenant-context read
 * happens.
 *
 * EquipmentProfile *is* tenant-owned, and is reached through a tenant session.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EquipmentClassProfile, ScenarioDefinition, SignalAlias, AlertRuleTemplate,
      ClientCatalogEntitlement, EquipmentProfile,
    ]),
    ClientCatalogModule,
  ],
  controllers: [CatalogController],
  providers: [CatalogService, CatalogAuthoringService, EntitlementService, RecommendationService],
  exports: [CatalogService, RecommendationService],
})
export class CatalogModule {}
