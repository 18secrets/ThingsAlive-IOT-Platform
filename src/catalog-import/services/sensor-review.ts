import { EntityManager, In } from 'typeorm';
import { Sensor } from '../../device-catalog/entities/sensor.entity';
import { SensorCategory } from '../../device-catalog/entities/sensor-category.entity';
import { CatalogImportRow } from '../entities/catalog-import-row.entity';
import { str, strOrNull } from './class-content';

/** Falls back to 'sensor' rather than an empty string — a name that is entirely
 * punctuation is rare, and an empty slug is worse than a wrong one. */
export function slugify(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'sensor';
}

interface CapabilityGroup {
  sensorSlugGiven: string | null;
  sensorName: string;
  parameterKey: string | null;
  rows: CatalogImportRow[];
}

export interface ConflictInfo {
  rowNumbers: number[];
  sensorLabel: string;
  fields: string[];
}

export interface DedupInfo {
  rowNumbers: number[];
}

export interface ProposedSensor {
  slug: string;
  name: string;
  category: string | null;
  parameterKey: string | null;
  canonicalUnit: string | null;
  proposedByRows: number[];
  usedByClasses: string[];
}

export interface ProposedCategory {
  slug: string;
  name: string;
  proposedBySensors: string[];
}

export interface RowResolution {
  row: CatalogImportRow;
  status: 'ok' | 'not_found' | 'ambiguous' | 'conflicting';
  message?: string;
  candidateSensor?: Sensor;
  nameMatchedSlug?: string;
}

export interface SensorCapabilityAnalysis {
  resolutions: RowResolution[];
  deduplicated: DedupInfo[];
  conflicts: ConflictInfo[];
  proposedSensors: ProposedSensor[];
  proposedCategories: ProposedCategory[];
}

/** What every caller uses when a batch has no `sensor_capability` rows at all —
 * shared so each does not redeclare its own loosely-typed empty shape. */
export const EMPTY_SENSOR_CAPABILITY_ANALYSIS: SensorCapabilityAnalysis = {
  resolutions: [], deduplicated: [], conflicts: [], proposedSensors: [], proposedCategories: [],
};

const groupKeyOf = (r: CatalogImportRow) => {
  const sensorSlugGiven = strOrNull(r.payload.sensor_slug);
  const sensorName = str(r.payload.sensor_name);
  const parameterKey = strOrNull(r.payload.parameter_key);
  return { sensorKey: sensorSlugGiven ?? slugify(sensorName), sensorSlugGiven, sensorName, parameterKey };
};

/** Everything a row declares about the capability — not `signal` alone, and not
 * including row-identity columns. Two rows agreeing on all of these describe the
 * same fact twice; disagreeing on any of them is a conflict, not a duplicate. */
const CAPABILITY_FIELDS = ['signal', 'canonical_unit', 'category'] as const;

const capabilitySignature = (r: CatalogImportRow): string =>
  CAPABILITY_FIELDS.map((f) => JSON.stringify(r.payload[f] ?? null)).join('|');

/**
 * Groups, dedups, resolves and proposes — one pass over a batch's `sensor_capability`
 * rows (task QIMP5). Read-only: nothing here writes anything, so the validator, the
 * dry-run diff and the approval endpoint's outstanding-proposals check all call it
 * and see the same answer, the same way `computeClassDiffEntry` (QIMP4) is one
 * computation shared by the diff and apply.
 *
 * The diagnostic that led to this task found the deployed resolver keyed on
 * `sensor_name`, one message covering two different conditions ("resolves to 0" and
 * "resolves to many"), and no distinction between an identical repeat (harmless) and
 * a conflicting one (a real error) — the workbook that prompted this task had rows
 * repeating one physical sensor's capability once per equipment class, which is not
 * a mistake worth rejecting.
 *
 * `signalSheetRows` is the batch's own `signal` sheet rows, used only to answer
 * "which classes use this sensor" — matched by the `signal` text both sheets carry,
 * the connection the template schema is built around. Purely informational: it
 * decides nothing about validity.
 */
export async function analyzeSensorCapability(
  m: EntityManager, capabilityRows: CatalogImportRow[], signalSheetRows: CatalogImportRow[],
): Promise<SensorCapabilityAnalysis> {
  const groups = new Map<string, CapabilityGroup>();
  for (const r of capabilityRows) {
    const { sensorKey, sensorSlugGiven, sensorName, parameterKey } = groupKeyOf(r);
    const key = `${sensorKey}::${parameterKey ?? ''}`;
    const existing = groups.get(key);
    if (existing) existing.rows.push(r);
    else groups.set(key, { sensorSlugGiven, sensorName, parameterKey, rows: [r] });
  }

  // One batched fetch per resolution strategy, not one query per row.
  const slugsGiven = [...new Set(
    [...groups.values()].map((g) => g.sensorSlugGiven).filter((s): s is string => !!s),
  )];
  const namesNeeded = [...new Set(
    [...groups.values()].filter((g) => !g.sensorSlugGiven).map((g) => g.sensorName.trim().toLowerCase()),
  )];
  const [bySlugRows, byNameRows] = await Promise.all([
    slugsGiven.length ? m.getRepository(Sensor).find({ where: { slug: In(slugsGiven) } }) : Promise.resolve([]),
    namesNeeded.length
      ? m.getRepository(Sensor).createQueryBuilder('s')
        .where('lower(trim(s.sensor_name)) IN (:...names)', { names: namesNeeded })
        .getMany()
      : Promise.resolve([]),
  ]);
  const bySlug = new Map(bySlugRows.map((s) => [s.slug, s]));
  const byNameLower = new Map<string, Sensor[]>();
  for (const s of byNameRows) {
    const k = s.sensorName.trim().toLowerCase();
    const list = byNameLower.get(k) ?? [];
    list.push(s);
    byNameLower.set(k, list);
  }

  const categoryNames = [...new Set(
    capabilityRows.map((r) => strOrNull(r.payload.category)).filter((c): c is string => !!c),
  )];
  const existingCategories = categoryNames.length
    ? await m.getRepository(SensorCategory).find({ where: { name: In(categoryNames) } })
    : [];
  const existingCategoryNames = new Set(existingCategories.map((c) => c.name.trim().toLowerCase()));

  const signalUsersFor = (signal: string): string[] => {
    const slugs = new Set<string>();
    for (const r of signalSheetRows) {
      if (str(r.payload.signal) === signal) slugs.add(str(r.payload.class_slug));
    }
    return [...slugs].sort();
  };

  const resolutions: RowResolution[] = [];
  const deduplicated: DedupInfo[] = [];
  const conflicts: ConflictInfo[] = [];
  const proposedSensorsByKey = new Map<string, ProposedSensor>();
  const proposedCategoriesBySlug = new Map<string, ProposedCategory>();

  for (const group of groups.values()) {
    const rowNumbers = group.rows.map((r) => r.rowNumber).sort((a, b) => a - b);
    const label = group.sensorSlugGiven ?? group.sensorName;

    if (group.rows.length > 1) {
      const differing = CAPABILITY_FIELDS.filter((f) =>
        new Set(group.rows.map((r) => JSON.stringify(r.payload[f] ?? null))).size > 1);
      if (differing.length) {
        conflicts.push({ rowNumbers, sensorLabel: label, fields: [...differing] });
        for (const r of group.rows) {
          resolutions.push({
            row: r, status: 'conflicting',
            message: `sensor_capability row ${r.rowNumber}: conflicts with row(s) `
              + `${rowNumbers.filter((n) => n !== r.rowNumber).join(', ')} on ${differing.join(', ')} `
              + `for "${label}" (conflicting_capability).`,
          });
        }
        continue;
      }
      // Identical in every field that matters — a repeat, not a rejection. Falls
      // through to resolve the group once, below; every row in it gets that answer.
      deduplicated.push({ rowNumbers });
    }

    const representative = group.rows[0];
    let resolved: { status: 'ok' | 'not_found' | 'ambiguous'; sensor?: Sensor; candidates?: Sensor[]; nameMatchedSlug?: string };
    if (group.sensorSlugGiven) {
      // Exact match, no fallback: a slug that does not exist is not-found even when
      // the row's own sensor_name would have matched something by name.
      const s = bySlug.get(group.sensorSlugGiven);
      resolved = s ? { status: 'ok', sensor: s } : { status: 'not_found' };
    } else {
      const candidates = byNameLower.get(group.sensorName.trim().toLowerCase()) ?? [];
      resolved = candidates.length === 0
        ? { status: 'not_found' }
        : candidates.length > 1
          ? { status: 'ambiguous', candidates }
          : { status: 'ok', sensor: candidates[0], nameMatchedSlug: candidates[0].slug };
    }

    for (const r of group.rows) {
      if (resolved.status === 'ok') {
        resolutions.push({
          row: r, status: 'ok', candidateSensor: resolved.sensor, nameMatchedSlug: resolved.nameMatchedSlug,
        });
      } else if (resolved.status === 'ambiguous') {
        const named = resolved.candidates!.map((c) => `${c.slug} (${c.sensorName})`).join(', ');
        resolutions.push({
          row: r, status: 'ambiguous',
          message: `sensor_capability row ${r.rowNumber}: "${group.sensorName}" matches more than one sensor `
            + `(${named}); name it by sensor_slug (sensor_ambiguous).`,
        });
      } else {
        resolutions.push({
          row: r, status: 'not_found',
          message: `sensor_capability row ${r.rowNumber}: "${label}" is not in the sensor catalog; `
            + 'it can be proposed for approval (sensor_not_found).',
        });
      }
    }

    // An ambiguous name is a naming problem the author resolves, not something to
    // propose creating — approving a sensor cannot fix "which of these did you mean".
    if (resolved.status === 'not_found') {
      const slug = group.sensorSlugGiven ?? slugify(group.sensorName);
      const category = strOrNull(representative.payload.category);
      const signal = str(representative.payload.signal);
      const existingProposal = proposedSensorsByKey.get(slug);
      if (existingProposal) {
        existingProposal.proposedByRows = [...existingProposal.proposedByRows, ...rowNumbers].sort((a, b) => a - b);
        existingProposal.usedByClasses = [...new Set([...existingProposal.usedByClasses, ...signalUsersFor(signal)])].sort();
      } else {
        proposedSensorsByKey.set(slug, {
          slug, name: group.sensorName, category,
          parameterKey: group.parameterKey, canonicalUnit: strOrNull(representative.payload.canonical_unit),
          proposedByRows: rowNumbers, usedByClasses: signalUsersFor(signal),
        });
      }

      if (category && !existingCategoryNames.has(category.trim().toLowerCase())) {
        const categorySlug = slugify(category);
        const existingCatProposal = proposedCategoriesBySlug.get(categorySlug);
        if (existingCatProposal) {
          if (!existingCatProposal.proposedBySensors.includes(slug)) existingCatProposal.proposedBySensors.push(slug);
        } else {
          proposedCategoriesBySlug.set(categorySlug, { slug: categorySlug, name: category, proposedBySensors: [slug] });
        }
      }
    }
  }

  return {
    resolutions, deduplicated, conflicts,
    proposedSensors: [...proposedSensorsByKey.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    proposedCategories: [...proposedCategoriesBySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}
