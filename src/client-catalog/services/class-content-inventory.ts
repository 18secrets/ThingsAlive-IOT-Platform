import { EntityManager } from 'typeorm';

export type ClassContentDisposition = 'copy' | 'is_the_class' | 'exclude';

export interface ClassContentEntry {
  table: string;
  disposition: ClassContentDisposition;
  /** Required for `exclude` — a silent omission is the defect this file exists to
   * remove; a stated reason is the only thing that distinguishes "considered and
   * decided against" from "nobody looked yet". */
  reason?: string;
  /** Required for `copy` and `is_the_class` (task QGRANT1): the tenant table a grant
   * writes. Named so a test can grant a class and look there, rather than trusting
   * the word `copy` — the claim this file used to stop at. */
  copiedTo?: string;
}

/**
 * Every table whose rows reference an equipment class, and the deliberate decision
 * made about each (task QGRANT0).
 *
 * This replaced a hand-maintained copy list inside `copy-on-grant.service.ts`
 * that nobody updated when a table was added — `equipment_class_formula` had
 * carried class content since QCE1 and was never copied to a single tenant. The
 * list itself was never wrong; it was simply never told about new tables. A test
 * now reads the live schema and refuses to pass with an entry missing — see
 * `findClassReferencingTables` and `auditClassContentTables` below, exercised in
 * `test/class-content-inventory.spec.ts`.
 */
export const CLASS_CONTENT_INVENTORY: ClassContentEntry[] = [
  // The class itself — not found by the audit query below (it has no class_slug
  // *column*, it *is* the row the column points at), listed anyway so the
  // inventory is a complete map of the class/content relationship, not just
  // whatever one SQL heuristic happens to catch.
  { table: 'equipment_class_profile', disposition: 'is_the_class', copiedTo: 'client_equipment_class' },

  // Copied today.
  { table: 'scenario_definition', disposition: 'copy', copiedTo: 'client_scenario' },
  {
    table: 'alert_rule_template', disposition: 'copy', copiedTo: 'alert_rule',
    reason: 'copied as a tenant alert_rule row, not as a second alert_rule_template copy',
  },
  // Fixed by this task (QGRANT0 §1) — the gap that started the audit.
  { table: 'equipment_class_formula', disposition: 'copy', copiedTo: 'client_formula' },
  // Task QREC0a: what was the profile's failure_modes jsonb, and the recommendations
  // that point at it. Copied to client_equipment_class_failure_mode and
  // client_equipment_class_recommendation.
  { table: 'equipment_class_failure_mode', disposition: 'copy', copiedTo: 'client_equipment_class_failure_mode' },
  { table: 'equipment_class_recommendation', disposition: 'copy', copiedTo: 'client_equipment_class_recommendation' },
  // Task QREC0b: the machine page. Copied to client_equipment_class_layout, where the
  // tenant may hide a widget and reorder.
  { table: 'equipment_class_layout', disposition: 'copy', copiedTo: 'client_equipment_class_layout' },
  // Not found by the audit query — site_class_layout keys on site_class_slug, not
  // class_slug — and that is exactly the case this inventory exists for. QREC0b's
  // prompt first listed it as `copy`; the audit is what showed nothing copies it.
  // Recorded here as a decision rather than left silently absent.
  // Task QREC0c: the visual's anchors are rows and the tenant's to move — copied to
  // client_equipment_class_visual_anchor. The visual itself is not copied: the image
  // is platform-owned and shared, so bandwidth stays flat and the cache stays warm.
  { table: 'equipment_class_visual_anchor', disposition: 'copy', copiedTo: 'client_equipment_class_visual_anchor' },
  {
    table: 'equipment_class_visual', disposition: 'exclude',
    reason: 'the image is platform-owned and shared by every tenant with the class — a tenant reads this '
      + 'row and the one object it names, never a copy of the bytes; only its anchors are copied',
  },
  {
    table: 'site_class', disposition: 'exclude',
    reason: 'platform-owned and read directly (resolveSiteClass); nothing grants a site class to a tenant, '
      + 'so there is no copy to make — the same shape as causal_chain',
  },
  {
    table: 'site_class_layout', disposition: 'exclude',
    reason: 'the site page, read directly by (site_class_slug, class_version); a tenant hide/reorder for '
      + 'site pages waits for QPAGE1, and a copy no code performs would be a claim, not a disposition',
  },

  // Platform-wide specifications, read directly by (class_slug[, class_version])
  // at the point of use. Nothing about either varies per tenant, so there is
  // nothing for a tenant copy to hold that the platform row does not already say.
  {
    table: 'causal_chain', disposition: 'exclude',
    reason: 'platform-owned, no tenant_id column by design (1757870000000-CausalChains.ts); '
      + 'read directly by equipment_class_slug in chain.service.ts at diagnosis time',
  },
  {
    table: 'equipment_class_sensor_requirement', disposition: 'exclude',
    reason: 'platform-owned spec versioned with the class; read directly by (class_slug, class_version) '
      + 'in signal-binding.service.ts and compared against the tenant\'s own signal_binding_version rows — '
      + 'the tenant owns their bindings, not the requirement spec',
  },

  // Not class content at all — each references a class for scoping or provenance,
  // not because the row belongs to the class the way a formula or scenario does.
  {
    table: 'client_catalog_entitlement', disposition: 'exclude',
    reason: 'the grant record itself — what was granted, not content the grant copies',
  },
  {
    table: 'equipment_profile', disposition: 'exclude',
    reason: 'the tenant\'s own equipment, mirrored read-only from the legacy backend — an instance of '
      + 'the class, never the class\'s content',
  },
  {
    table: 'alert_rule', disposition: 'exclude',
    reason: 'the tenant\'s own rule, already created by copyForTenant from alert_rule_template — this is '
      + 'the copy\'s destination, not a second platform source needing one',
  },
  // Found by QGRANT1's wider audit: `site_class_slug` was invisible to the old
  // two-column match, and nothing recorded a decision about it.
  {
    table: 'plant', disposition: 'exclude',
    reason: 'the tenant\'s own site; site_class_slug chooses which platform site class renders its page — '
      + 'the same instance-of relationship equipment_profile has with an equipment class, not content to copy',
  },
  {
    table: 'utilization_shift', disposition: 'exclude',
    reason: 'tenant-owned computed shift scoring (its own tenant_id and RLS policy); equipment_class_slug '
      + 'is denormalised onto it for reporting, not a reference to content that needs copying',
  },
];

/**
 * Every table in the live schema with a column ending in `class_slug` — the
 * structural signal a table holds something scoped to a class. Deliberately a
 * column-name heuristic, not an attempt to infer intent: the inventory above is
 * where intent is decided, by a person, once per table. Widened by task QGRANT1
 * from two exact names, which could not see `plant.site_class_slug`.
 */
export async function findClassReferencingTables(m: EntityManager): Promise<string[]> {
  const rows: { table_name: string }[] = await m.query(`
    SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name LIKE '%class\\_slug' ESCAPE '\\'
      ORDER BY table_name`);
  return rows.map((r) => r.table_name);
}

/** Tables the live schema has that the inventory does not mention. Empty means
 * every class-referencing table has a deliberate, recorded disposition. A table
 * named as some entry's `copiedTo` is covered: it is where a copy lands, not a
 * second source needing a decision of its own. */
export function auditClassContentTables(liveTables: string[], inventory: ClassContentEntry[]): string[] {
  const known = new Set(inventory.flatMap((e) => (e.copiedTo ? [e.table, e.copiedTo] : [e.table])));
  return liveTables.filter((t) => !known.has(t));
}

/** `copy` with no `copiedTo` is a claim with nowhere to check it (task QGRANT1). */
export function entriesMissingDestination(inventory: ClassContentEntry[]): string[] {
  return inventory
    .filter((e) => (e.disposition === 'copy' || e.disposition === 'is_the_class') && !e.copiedTo?.trim())
    .map((e) => e.table);
}

/** `exclude` with no `reason` is the same silence this file exists to remove —
 * enforced here rather than left to review, so a future entry cannot skip it by
 * omission the same way the formula copy itself once did. */
export function entriesMissingReason(inventory: ClassContentEntry[]): string[] {
  return inventory.filter((e) => e.disposition === 'exclude' && !e.reason?.trim()).map((e) => e.table);
}
