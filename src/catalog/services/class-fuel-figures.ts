import { EntityManager } from 'typeorm';

/**
 * The cold-start fuel figures on `equipment_class_profile` (`1763400000000-ClassFuelFigures`),
 * read and written only here, by name.
 *
 * Mapped on the entity as `select: false, insert: false, update: false`, so no ordinary
 * find or save mentions them. That is deliberate: specs that roll the schema back below
 * this migration to test an older one's down path then create a class through the normal
 * services (twin-model.spec.ts), and an entity that selected these columns would fail
 * there for a reason that has nothing to do with the migration under test. A version's
 * figures are therefore written after the row (the import), and copied when a version is
 * forked (authoring), by these functions.
 */
export interface ClassFuelFigureValues {
  nominalFuelSource: string | null;
  ratedPowerKw: number | null;
  workingLoadPct: number | null;
  bsfcGPerKwh: number | null;
  bsfcSource: string | null;
  idleFuelPerHour: number | null;
  workingShare: number | null;
}

const COLUMNS: [keyof ClassFuelFigureValues, string][] = [
  ['nominalFuelSource', 'nominal_fuel_source'], ['ratedPowerKw', 'rated_power_kw'],
  ['workingLoadPct', 'working_load_pct'], ['bsfcGPerKwh', 'bsfc_g_per_kwh'], ['bsfcSource', 'bsfc_source'],
  ['idleFuelPerHour', 'idle_fuel_per_hour'], ['workingShare', 'working_share'],
];

export const NO_FUEL_FIGURES: ClassFuelFigureValues = {
  nominalFuelSource: null, ratedPowerKw: null, workingLoadPct: null, bsfcGPerKwh: null, bsfcSource: null,
  idleFuelPerHour: null, workingShare: null,
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** One class version's figures; all null when the version does not exist. */
export async function readFuelFigures(m: EntityManager, slug: string, version: number): Promise<ClassFuelFigureValues> {
  const [row] = await m.query(
    `SELECT ${COLUMNS.map(([, c]) => `"${c}"`).join(', ')} FROM "equipment_class_profile" WHERE "slug" = $1 AND "version" = $2`,
    [slug, version],
  );
  if (!row) return { ...NO_FUEL_FIGURES };
  return {
    nominalFuelSource: row.nominal_fuel_source ?? null, ratedPowerKw: num(row.rated_power_kw),
    workingLoadPct: num(row.working_load_pct), bsfcGPerKwh: num(row.bsfc_g_per_kwh), bsfcSource: row.bsfc_source ?? null,
    idleFuelPerHour: num(row.idle_fuel_per_hour), workingShare: num(row.working_share),
  };
}

/** Set one class row's figures, all at once, so the database checks them together. */
export async function writeFuelFigures(m: EntityManager, classId: string, f: Partial<ClassFuelFigureValues>): Promise<void> {
  await m.query(
    `UPDATE "equipment_class_profile" SET ${COLUMNS.map(([, c], i) => `"${c}" = $${i + 2}`).join(', ')} WHERE "id" = $1`,
    [classId, ...COLUMNS.map(([k]) => f[k] ?? null)],
  );
}

/** A forked version starts with the figures of the version it came from. */
export async function copyFuelFigures(m: EntityManager, slug: string, fromVersion: number, toVersion: number): Promise<void> {
  await m.query(
    `UPDATE "equipment_class_profile" t
        SET ${COLUMNS.map(([, c]) => `"${c}" = f."${c}"`).join(', ')}
       FROM "equipment_class_profile" f
      WHERE t."slug" = $1 AND t."version" = $3 AND f."slug" = $1 AND f."version" = $2`,
    [slug, fromVersion, toVersion],
  );
}
