import { ParameterModule } from '../parameters/parameter.module';
import { Module } from '@nestjs/common';
import { AlertModule } from '../alert/alert.module';
import { ForecastModule } from '../forecast/forecast.module';
import { ClientCatalogModule } from '../client-catalog/client-catalog.module';
import { KpiModule } from '../kpi/kpi.module';
import { ServiceModule } from '../service/service.module';
import { SignalBindingModule } from '../signal-binding/signal-binding.module';
import { WorkModule } from '../work/work.module';
import { PageController } from './page.controller';
import { SiteTwinController } from '../site-twin/site-twin.controller';
import { SiteTwinModule } from '../site-twin/site-twin.module';
import { PageService } from './page.service';
import { LegacyModule } from '../legacy/legacy.module';

/** Imports producers and adds none (task QPAGE1 §0). The site twin's controller sits
 * here because a save answers with the composed twin. */
@Module({
  imports: [KpiModule, SignalBindingModule, AlertModule, WorkModule, ServiceModule, ClientCatalogModule, ParameterModule, ForecastModule, SiteTwinModule, LegacyModule],
  controllers: [PageController, SiteTwinController],
  providers: [PageService],
  exports: [PageService],
})
export class PageModule {}
