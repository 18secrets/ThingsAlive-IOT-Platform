import { Module } from '@nestjs/common';
import { AlertModule } from '../alert/alert.module';
import { ClientCatalogModule } from '../client-catalog/client-catalog.module';
import { KpiModule } from '../kpi/kpi.module';
import { ServiceModule } from '../service/service.module';
import { SignalBindingModule } from '../signal-binding/signal-binding.module';
import { WorkModule } from '../work/work.module';
import { PageController } from './page.controller';
import { PageService } from './page.service';

/** Imports producers and adds none (task QPAGE1 §0). */
@Module({
  imports: [KpiModule, SignalBindingModule, AlertModule, WorkModule, ServiceModule, ClientCatalogModule],
  controllers: [PageController],
  providers: [PageService],
})
export class PageModule {}
