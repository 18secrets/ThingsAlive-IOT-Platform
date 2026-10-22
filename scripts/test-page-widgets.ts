import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/database/data-source';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { KpiEvaluatorService } from '../src/kpi/services/kpi-evaluator.service';
import { PageService } from '../src/page/page.service';
import { ClientCatalogService } from '../src/client-catalog/services/client-catalog.service';
import { CopyOnGrantService } from '../src/client-catalog/services/copy-on-grant.service';
import { ForecastReader } from '../src/forecast/forecast-reader';
import { ParameterService } from '../src/parameters/services/parameter.service';
import { AlertService } from '../src/alert/services/alert.service';
import { WorkOrderService } from '../src/work/services/work-order.service';
import { ServiceForecastService } from '../src/service/services/service-forecast.service';

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://postgres:CdhlqhgUKSBzboKMRAItBDaYHJiMgYsI@crossover.proxy.rlwy.net:47609/railway';

async function main() {
  process.env.DATABASE_URL = connectionString;
  const ds = new DataSource(dataSourceOptions(process.env, { appRole: null }));
  await ds.initialize();

  const bindings = new SignalBindingService(ds);
  const kpis = new KpiEvaluatorService(ds, bindings);
  const reader = new ForecastReader(kpis);
  const copyOnGrant = new CopyOnGrantService(ds);
  const clientCatalog = new ClientCatalogService(ds, copyOnGrant);
  const parameters = new ParameterService(ds);
  const alerts = new AlertService(ds);
  const workOrders = new WorkOrderService(ds);
  const service = new ServiceForecastService(ds);
  const storage = {} as any;

  const page = new PageService(
    ds, kpis, bindings, alerts, workOrders, service, clientCatalog, parameters, storage, reader
  );

  const scope = { tenantId: 'demo-construction', userId: 'u1', roles: ['admin'], isPlatformRole: false };
  const res = await page.machinePage(scope, { sourceSystem: 'seed-demo', externalId: 'EX-01' }, new Date());

  console.log('\n===============================================================');
  console.log('Total Widgets returned for EX-01:', res.widgets.length);
  for (const w of res.widgets) {
    const isReady = w.readiness === 'ready';
    console.log(`[${w.widgetType}] key="${w.widgetKey}" readiness="${w.readiness}" reason="${w.reason}" title="${w.title}" dataPresent=${!!w.data}`);
    if (isReady && w.widgetType === 'kpi_number') {
      console.log(`   -> KPI Number Value: ${(w.data as any)?.value} ${(w.data as any)?.unit || ''}`);
    } else if (isReady && w.widgetType === 'kpi_chart') {
      console.log(`   -> KPI Chart points: ${(w.data as any)?.points?.length}, unit: ${(w.data as any)?.unit}`);
    } else if (isReady && w.widgetType === 'forecast_chart') {
      console.log(`   -> Forecast Horizon points: ${(w.data as any)?.horizon?.length}, Signal: ${(w.data as any)?.signal}`);
    }
  }
  console.log('===============================================================\n');

  await ds.destroy();
}

main().catch(console.error);
