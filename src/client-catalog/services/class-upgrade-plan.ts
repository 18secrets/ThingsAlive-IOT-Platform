/**
 * What a class upgrade does to one kind of tenant content (task QUPGRADE1) — a pure
 * function, like QREC0b's layout merge and QREC0c's anchor merge, so every rule in the
 * table below is testable without a database.
 *
 * Origin is computed, never stored: each tenant row is compared with the template row
 * **at the version it was copied from**. That version is immutable once published, so
 * the answer cannot drift — and a stored flag would have needed a backfill guess for
 * every copy already in the field, where a wrong guess silently overwrites an edit.
 */
export type Origin = 'inherited' | 'customised' | 'tenant_added';
export type Upstream = 'unchanged' | 'changed' | 'removed' | 'added';
export type UpgradeAction = 'replace' | 'keep' | 'orphan' | 'add';

export interface PlannedChange<T> {
  key: string;
  /** null for a row the new version adds and the tenant never had. */
  origin: Origin | null;
  upstream: Upstream;
  action: UpgradeAction;
  /** Present for `replace` and `add`: the new version's row. */
  next?: T;
}

export interface ContentKind<T> {
  key: (row: T) => string;
  /** The fields that are the content — what a tenant edit changes. Provenance,
   * timestamps and ids are not content and are never compared. */
  content: (row: T) => unknown;
}

/**
 * | tenant row   | new version      | action  |
 * |--------------|------------------|---------|
 * | inherited    | changed / same   | replace |
 * | inherited    | removed          | orphan  |
 * | customised   | changed / same   | keep    |
 * | customised   | removed          | orphan  |
 * | tenant_added | —                | keep    |
 * | (absent)     | added            | add     |
 *
 * `baseFor(row)` is the template row the tenant row was copied from, or undefined if
 * the version it names has no row with this key — which is what tenant-added means.
 */
export function planUpgrade<Tenant, Template>(
  tenantRows: Tenant[],
  baseFor: (row: Tenant) => Template | undefined,
  nextRows: Template[],
  tenantKind: ContentKind<Tenant>,
  templateKind: ContentKind<Template>,
): PlannedChange<Template>[] {
  const nextByKey = new Map(nextRows.map((r) => [templateKind.key(r), r]));
  const out: PlannedChange<Template>[] = [];
  const seen = new Set<string>();

  for (const row of tenantRows) {
    const key = tenantKind.key(row);
    seen.add(key);
    const base = baseFor(row);
    const next = nextByKey.get(key);
    if (!base) {
      out.push({ key, origin: 'tenant_added', upstream: next ? 'added' : 'unchanged', action: 'keep' });
      continue;
    }
    const origin: Origin = same(tenantKind.content(row), templateKind.content(base)) ? 'inherited' : 'customised';
    if (!next) {
      out.push({ key, origin, upstream: 'removed', action: 'orphan' });
      continue;
    }
    const upstream: Upstream = same(templateKind.content(base), templateKind.content(next)) ? 'unchanged' : 'changed';
    out.push(origin === 'inherited'
      ? { key, origin, upstream, action: 'replace', next }
      : { key, origin, upstream, action: 'keep' });
  }

  for (const [key, next] of nextByKey) {
    if (!seen.has(key)) out.push({ key, origin: null, upstream: 'added', action: 'add', next });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Structural equality over plain content: key order and number-vs-numeric-string
 * (Postgres `numeric` comes back as a string) do not count as an edit. */
export function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  return JSON.stringify(normalise(v));
}

function normalise(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    return Number(v);
  }
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = normalise((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
