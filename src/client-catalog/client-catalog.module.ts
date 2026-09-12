import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientCatalogController } from './client-catalog.controller';
import { ClientEquipmentClass } from './entities/client-equipment-class.entity';
import { ClientScenario } from './entities/client-scenario.entity';
import { ClientCatalogService } from './services/client-catalog.service';
import { CopyOnGrantService } from './services/copy-on-grant.service';

/**
 * The client's own copies. Registered separately from the catalog module because the
 * two have different owners, and keeping them apart is what makes it visible that
 * the template-authoring service has no route into these tables.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ClientEquipmentClass, ClientScenario])],
  controllers: [ClientCatalogController],
  providers: [ClientCatalogService, CopyOnGrantService],
  exports: [ClientCatalogService, CopyOnGrantService],
})
export class ClientCatalogModule {}
