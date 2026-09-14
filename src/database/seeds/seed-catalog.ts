import 'reflect-metadata'; // standalone script: Nest normally loads this for us

import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource, EntityManager } from 'typeorm';
import { ClientCatalogEntitlement } from '../../catalog/entities/client-catalog-entitlement.entity';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../../catalog/entities/scenario-definition.entity';
import { SignalAlias } from '../../catalog/entities/signal-alias.entity';
import dataSource from '../data-source';

/**
 * Loads the reviewed class profiles into the catalog (task P1-03).
 *
 * The content in `catalog/` is drafted from OEM documentation — Kirloskar controller
 * defaults, Caterpillar's underloading guidance, ISO 10816-3, metalworking fluid
 * practice — and every profile ships as `draft`. Draft is invisible to tenants by
 * construction, so nothing here can be activated until somebody who knows the
 * machines has read it and published it. A drafted threshold and a reviewed one look
 * identical in a JSON file; the status column is what tells them apart.
 *
 *   npx ts-node src/database/seeds/seed-catalog.ts             # load as drafted
 *   npx ts-node src/database/seeds/seed-catalog.ts --publish   # test databases only
 *
 * Idempotent on (slug, version): re-running changes nothing, and a content change
 * needs a version bump rather than an edit, because a published definition is
 * immutable and activations pin the version they ran against.
 */

interface ClassFile {
  slug: string; version: number; status: string; name: string;
  description: string | null; category: string | null;
  expectedSignals: { signal: string; unit: string | null; required: boolean; description?: string }[];
  failureModes: { code: string; name: string; symptom: string; signals: string[] }[];
  defaultThresholds: Record<string, unknown>;
}

interface ScenarioFile {
  slug: string; version: number; status: string; equipmentClassSlug: string;
  name: string; description: string; severity: string; tier: number;
  requiredSignals: string[]; minimumHistoryDays: number; parameters: unknown[];
}

interface AliasFile {
  sourceSystem: string; alias: string; canonical: string;
  unit: string | null; note: string | null;
}

const here = join(__dirname, 'catalog');
const read = <T>(name: string): T => JSON.parse(readFileSync(join(here, name), 'utf8')) as T;

/**
 * A scenario may only require a signal its class declares.
 *
 * Without this check a typo in a signal name produces a scenario that is permanently
 * blocked with `missing-signals: ['coolent_temp']`, and the customer is told to fit a
 * sensor that is already fitted. The recommendation engine cannot tell a misspelling
 * from a genuinely absent sensor, so the catalog has to refuse the misspelling at
 * load time.
 */
export function checkSignalsDeclared(classes: ClassFile[], scenarios: ScenarioFile[]): string[] {
  const declared = new Map<string, Set<string>>();
  for (const c of classes) {
    declared.set(c.slug, new Set(c.expectedSignals.map((s) => s.signal)));
  }

  const problems: string[] = [];
  for (const s of scenarios) {
    const known = declared.get(s.equipmentClassSlug);
    if (!known) {
      problems.push(`${s.slug}: no class "${s.equipmentClassSlug}"`);
      continue;
    }
    for (const signal of s.requiredSignals) {
      if (!known.has(signal)) {
        problems.push(`${s.slug}: requires "${signal}", which ${s.equipmentClassSlug} does not declare`);
      }
    }
  }

  // Failure modes reference signals too, and a mode naming a signal the class does
  // not have is a description nobody can act on.
  for (const c of classes) {
    const known = declared.get(c.slug)!;
    for (const mode of c.failureModes) {
      for (const signal of mode.signals) {
        if (!known.has(signal)) {
          problems.push(`${c.slug}/${mode.code}: names "${signal}", which the class does not declare`);
        }
      }
    }
  }
  return problems;
}

/** Aliases must resolve to something. A canonical name nothing declares is dead weight. */
export function checkAliasTargets(classes: ClassFile[], aliases: AliasFile[]): string[] {
  const declared = new Set(classes.flatMap((c) => c.expectedSignals.map((s) => s.signal)));
  const extras = new Set(['throttle_position', 'gsm_signal_strength', 'ground_speed']);
  return aliases
    .filter((a) => !declared.has(a.canonical) && !extras.has(a.canonical))
    .map((a) => `alias "${a.alias}" resolves to "${a.canonical}", which no class declares`);
}

export async function seedCatalog(m: EntityManager, publish: boolean): Promise<Record<string, number>> {
  const classes = read<ClassFile[]>('equipment-classes.json');
  const scenarios = read<ScenarioFile[]>('scenarios.json');
  const aliases = read<AliasFile[]>('signal-aliases.json');

  const problems = [...checkSignalsDeclared(classes, scenarios), ...checkAliasTargets(classes, aliases)];
  if (problems.length) {
    throw new Error(`Catalog is inconsistent; nothing was written:\n  ${problems.join('\n  ')}`);
  }

  const status = (declared: string) => (publish ? 'published' : declared);
  const publishedAt = publish ? new Date() : null;
  const counts: Record<string, number> = { classes: 0, scenarios: 0, aliases: 0 };

  const classRepo = m.getRepository(EquipmentClassProfile);
  for (const c of classes) {
    const existing = await classRepo.findOne({ where: { slug: c.slug, version: c.version } });
    await classRepo.save(classRepo.create({
      ...(existing ?? {}), ...c,
      status: status(c.status) as any,
      publishedAt: publish ? publishedAt : null,
    }));
    counts.classes += 1;
  }

  const scenarioRepo = m.getRepository(ScenarioDefinition);
  for (const s of scenarios) {
    const existing = await scenarioRepo.findOne({ where: { slug: s.slug, version: s.version } });
    await scenarioRepo.save(scenarioRepo.create({
      ...(existing ?? {}), ...s,
      severity: s.severity as any,
      tier: s.tier as any,
      status: status(s.status) as any,
      publishedAt: publish ? publishedAt : null,
    }));
    counts.scenarios += 1;
  }

  const aliasRepo = m.getRepository(SignalAlias);
  for (const a of aliases) {
    const existing = await aliasRepo.findOne({
      where: { sourceSystem: a.sourceSystem, alias: a.alias.toLowerCase() },
    });
    // Stored lower-cased, because resolution is case-insensitive and a table holding
    // both "FuelLevel" and "fuellevel" would make the unique index meaningless.
    await aliasRepo.save(aliasRepo.create({ ...(existing ?? {}), ...a, alias: a.alias.toLowerCase() }));
    counts.aliases += 1;
  }

  return counts;
}

async function main() {
  const publish = process.argv.includes('--publish');
  const ds: DataSource = await dataSource.initialize();
  try {
    const counts = await seedCatalog(ds.manager, publish);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ...counts, publishedImmediately: publish }, null, 2));
    if (!publish) {
      // eslint-disable-next-line no-console
      console.log(
        'Loaded as draft. Tenants cannot see or activate a draft — publish only after domain review.',
      );
    }
    const granted = await ds.getRepository(ClientCatalogEntitlement).count();
    // eslint-disable-next-line no-console
    console.log(`${granted} entitlement(s) exist. A published catalog with no grants is visible to nobody.`);
  } finally {
    await ds.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
