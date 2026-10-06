import { EntityManager } from 'typeorm';
import { ParameterScope, RESOLUTION_ORDER } from '../parameter-catalog';

/** Where to look, one ref per scope. A machine with no plant or no class simply has no
 * row at that level to find — the chain does not break, it skips. */
export interface ParameterChain {
  equipment?: string | null;
  equipment_class?: string | null;
  site?: string | null;
}

export interface ParameterRow {
  scope: ParameterScope;
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
  source: { scope: ParameterScope; scopeRef: string | null; effectiveFrom: string };
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
    for (const scope of RESOLUTION_ORDER) {
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
  const rows = raw.map((r) => ({ ...r, effectiveFrom: new Date(r.effectiveFrom) }));
  return resolveFromRows(rows, chain, names);
}

/** The chain for one machine: its own profile id, its class, its plant. */
export function chainForEquipment(
  profile: { id: string; equipmentClassSlug: string | null; plantId: string | null },
): ParameterChain {
  return { equipment: profile.id, equipment_class: profile.equipmentClassSlug, site: profile.plantId };
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
