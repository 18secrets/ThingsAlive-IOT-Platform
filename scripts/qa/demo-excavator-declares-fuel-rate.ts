import { DataSource } from 'typeorm';
import { RequestScope } from '../../src/auth/types/request-scope';
import { AlertRuleTemplate } from '../../src/catalog/entities/alert-rule-template.entity';
import { EquipmentClassFormula } from '../../src/catalog/entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../../src/catalog/entities/equipment-class-profile.entity';
import { NamedFormula } from '../../src/catalog/entities/named-formula.entity';
import { ScenarioDefinition } from '../../src/catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../../src/catalog/entities/signal-alias.entity';
import { CatalogAuthoringService } from '../../src/catalog/services/catalog-authoring.service';
import { dataSourceOptions } from '../../src/database/data-source';
import { SensorRoleCapability } from '../../src/device-catalog/entities/sensor-role-capability.entity';

/**
 * Fuel test report FU-7: "demo-excavator lacks the fuel_consumption signal." Its machines
 * on Development report fuel_consumption (L/h) and have it bound, but the class does not
 * declare it, so OEE's Quality and the fuel rate KPI see it as unbound for them.
 *
 * Forks demo-excavator's published version into a draft that declares fuel_consumption
 * (L/h, not required), through the authoring service, and publishes it — every check
 * authoring runs, runs. Accounts on the current version keep it until they upgrade (D49).
 *
 *   DATABASE_URL=<owner url> npx ts-node scripts/qa/demo-excavator-declares-fuel-rate.ts            # dry run
 *   DATABASE_URL=<owner url> npx ts-node scripts/qa/demo-excavator-declares-fuel-rate.ts --apply    # write
 *
 * Does nothing when the newest version already declares it, so it runs once.
 */
const SLUG = 'demo-excavator';
const SIGNAL = { signal: 'fuel_consumption', unit: 'L/h', required: false, description: 'Fuel burn rate' };

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (the owner\'s login).');
  const ds = new DataSource(dataSourceOptions(process.env, { appRole: null }));
  await ds.initialize();
  try {
    const newest = await ds.getRepository(EquipmentClassProfile).findOne({ where: { slug: SLUG }, order: { version: 'DESC' } });
    if (!newest) throw new Error(`No class "${SLUG}".`);
    if (newest.expectedSignals.some((s) => s.signal === SIGNAL.signal)) {
      console.log(`${SLUG} v${newest.version} (${newest.status}) already declares ${SIGNAL.signal}. Nothing to do.`);
      return;
    }
    console.log(`${SLUG} v${newest.version} (${newest.status}) declares ${newest.expectedSignals.map((s) => s.signal).join(', ')}.`);
    if (!apply) {
      console.log(`Dry run: would publish v${newest.status === 'draft' ? newest.version : newest.version + 1} adding ${SIGNAL.signal}. Add --apply to write.`);
      return;
    }
    const authoring = new CatalogAuthoringService(
      ds.getRepository(EquipmentClassProfile), ds.getRepository(EquipmentClassFormula), ds.getRepository(ScenarioDefinition),
      ds.getRepository(SignalAlias), ds.getRepository(AlertRuleTemplate), ds.getRepository(NamedFormula),
      ds.getRepository(SensorRoleCapability),
    );
    const scope: RequestScope = { tenantId: 'platform', userId: 'fuel-report-FU-7', roles: ['master-admin'], isPlatformRole: true };
    const draft = await authoring.editClass(scope, SLUG, { expectedSignals: [...newest.expectedSignals, SIGNAL] } as never);
    const published = await authoring.publishClass(scope, SLUG);
    console.log(`Published ${SLUG} v${published.version} (draft was v${draft.version}), now declaring ${SIGNAL.signal}.`);
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
