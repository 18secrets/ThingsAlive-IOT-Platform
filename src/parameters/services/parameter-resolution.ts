import { EntityManager } from 'typeorm';
import { ParameterScope } from '../parameter-catalog';

/**
 * Where a resolved value can come from: the four scopes a tenant sets values at, plus
 * the machine's model (D57), whose rated figures are read, never set, here.
 */
export type ResolvedScope = ParameterScope | 'model';

/**
 * Most specific first. The model sits between the machine and its class: a nameplate
 * value typed on the machine beats the model's catalogue figure, and the model's figure
 * beats anything said for the whole class, which spans many models.
 */
export const RESOLVED_ORDER: readonly ResolvedScope[] = ['equipment', 'model', 'equipment_class', 'site', 'client'];

/** Where to look, one ref per scope. A machine with no plant, class or model simply has
 * no row at that level to find — the chain does not break, it skips. */
export interface ParameterChain {
  equipment?: string | null;
  model?: string | null;
  equipment_class?: string | null;
  site?: string | null;
}

export interface ParameterRow {
  scope: ResolvedScope;
  scopeRef: string | null;
  name: string;
  value: unknown;
  unit: string | null;
  effectiveFrom: Date;
}

export interface ResolvedParameter {
  name: string;
  value: unknown;
  unit: string | null;
  /** Which row answered — "why is this number what it is" without reading the database. */
  source: { scope: ResolvedScope; scopeRef: string | null; effectiveFrom: string };
}

/**
 * Per field, most specific wins (task QPARAM1 §3).
 *
 * Each name is resolved on its own. A machine overriding only `operating_cost_per_hour`
 * still inherits `fuel_price` from its site; resolving a whole profile at one level
 * would make that override silently blank the site's fuel price.
 *
 * `rows` must already be the latest row per (scope, scope_ref, name) at the instant
 * asked about. A latest row that is a clear (JSON null) means this scope no longer
 * says anything, so the next scope up answers — clearing an override restores the
 * inherited value rather than leaving the machine with none.
 */
export function resolveFromRows(
  rows: readonly ParameterRow[], chain: ParameterChain, names: readonly string[],
): Map<string, ResolvedParameter | null> {
  const out = new Map<string, ResolvedParameter | null>();
  for (const name of names) {
    let found: ResolvedParameter | null = null;
    for (const scope of RESOLVED_ORDER) {
      const ref = scope === 'client' ? null : chain[scope] ?? undefined;
      if (ref === undefined) continue;
      const row = rows.find((r) => r.name === name && r.scope === scope && r.scopeRef === ref);
      if (!row || row.value === null) continue;
      found = {
        name, value: row.value, unit: row.unit,
        source: { scope, scopeRef: row.scopeRef, effectiveFrom: row.effectiveFrom.toISOString() },
      };
      break;
    }
    out.set(name, found);
  }
  return out;
}

/**
 * Loads the rows `resolveFromRows` needs and resolves them, in the caller's
 * transaction — so it runs under whatever tenant session the caller already holds,
 * and the evaluator's read and this one see the same snapshot.
 */
export async function resolveParameters(
  m: EntityManager, tenantId: string, chain: ParameterChain, names: readonly string[], at: Date,
): Promise<Map<string, ResolvedParameter | null>> {
  if (!names.length) return new Map();
  const raw: {
    scope: ParameterScope; scopeRef: string | null; name: string; value: unknown;
    unit: string | null; effectiveFrom: Date;
  }[] = await m.query(
    `SELECT DISTINCT ON ("scope", COALESCE("scope_ref", ''), "name")
            "scope", "scope_ref" AS "scopeRef", "name", "value", "unit", "effective_from" AS "effectiveFrom"
       FROM "tenant_parameter"
      WHERE "tenant_id" = $1
        AND "name" = ANY($2::text[])
        AND "effective_from" <= $3
        AND (    "scope" = 'client'
              OR ("scope" = 'site' AND "scope_ref" = $4)
              OR ("scope" = 'equipment_class' AND "scope_ref" = $5)
              OR ("scope" = 'equipment' AND "scope_ref" = $6))
      ORDER BY "scope", COALESCE("scope_ref", ''), "name", "effective_from" DESC`,
    [tenantId, names, at, chain.site ?? null, chain.equipment_class ?? null, chain.equipment ?? null],
  );
  const rows: ParameterRow[] = raw.map((r) => ({ ...r, effectiveFrom: new Date(r.effectiveFrom) }));

  // The model's rated figures (D57). No effective time of their own: a rating describes
  // the model, not a moment, so a corrected figure applies to every window it is read
  // for. `effectiveFrom` reports when it was last changed, which is what "why is this
  // number what it is" needs.
  if (chain.model) {
    const ratings: { name: string; value: number; unit: string | null; updatedAt: Date }[] = await m.query(
      `SELECT r."name", r."value", p."unit", r."updated_at" AS "updatedAt"
         FROM "client_equipment_template_rating" r
         JOIN "rating_parameter" p ON p."name" = r."name"
        WHERE r."tenant_id" = $1 AND r."template_id" = $2 AND r."name" = ANY($3::text[])`,
      [tenantId, chain.model, names],
    );
    for (const r of ratings) {
      rows.push({
        scope: 'model', scopeRef: chain.model, name: r.name, value: r.value, unit: r.unit,
        effectiveFrom: new Date(r.updatedAt),
      });
    }
  }
  return resolveFromRows(rows, chain, names);
}

/** The chain for one machine: its own profile id, its model, its class, its plant. */
export function chainForEquipment(
  profile: { id: string; equipmentClassSlug: string | null; plantId: string | null; modelId?: string | null },
): ParameterChain {
  return {
    equipment: profile.id, model: profile.modelId ?? null,
    equipment_class: profile.equipmentClassSlug, site: profile.plantId,
  };
}

/** A tenant `stale_after_seconds` for this machine, or null when none is set. */
export async function tenantStaleAfterSeconds(
  m: EntityManager, tenantId: string,
  profile: { id: string; equipmentClassSlug: string | null; plantId: string | null }, at: Date,
): Promise<number | null> {
  const resolved = await resolveParameters(m, tenantId, chainForEquipment(profile), ['stale_after_seconds'], at);
  const value = resolved.get('stale_after_seconds')?.value;
  return typeof value === 'number' ? value : null;
}
