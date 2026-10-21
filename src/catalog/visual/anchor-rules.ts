export interface Anchor {
  signal: string;
  hotspotX: number;
  hotspotY: number;
  label: string | null;
}

export interface TenantAnchor extends Anchor {
  /** The tenant moved or added it — never moved by a new class version. */
  placementCustom: boolean;
}

/**
 * Every reason an anchor set is refused, each naming what (task QREC0c §2). An anchor
 * on a signal the class does not declare is refused — never a silent fallback. The
 * demo's `anchorParts[key] || anchorParts.engine_runtime` put a new signal on the wrong
 * part of the machine and told nobody; a coolant temperature drawn on the fuel tank is
 * worse than no diagram.
 */
export function anchorProblems(anchors: Anchor[], declaredSignals: Iterable<string>): string[] {
  const declared = new Set(declaredSignals);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const a of anchors) {
    if (seen.has(a.signal)) problems.push(`signal "${a.signal}" has more than one anchor.`);
    seen.add(a.signal);
    if (!declared.has(a.signal)) problems.push(`anchor for signal "${a.signal}", which the class does not declare.`);
    for (const [axis, v] of [['x', a.hotspotX], ['y', a.hotspotY]] as const) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
        problems.push(`anchor for "${a.signal}" has hotspot_${axis} ${v}; it must be a percentage, 0 to 100.`);
      }
    }
  }
  return problems;
}

/** Signals with no marker — listed beside the visual for the tenant to place, never
 * put on a nearby anchor. */
export function unplacedSignals(declaredSignals: string[], anchors: Pick<Anchor, 'signal'>[]): string[] {
  const placed = new Set(anchors.map((a) => a.signal));
  return declaredSignals.filter((s) => !placed.has(s));
}

/**
 * A tenant's anchor set carried onto a new class version (task QREC0c §4) — a pure
 * function, as QREC0b's layout merge is, so the rule is testable before QUPGRADE1
 * exists to call it.
 *
 *  - a class-origin anchor takes the new version's position and label;
 *  - a tenant-placed anchor (`placementCustom`) keeps its position, whatever the new
 *    version says about that signal, and stays marked;
 *  - a class-origin anchor the new version no longer has is dropped;
 *  - a tenant-placed anchor survives even if the new version has no anchor for its
 *    signal — the tenant put it there deliberately;
 *  - a new class anchor arrives for any signal the tenant has not placed.
 */
export function mergeTenantAnchors(copy: TenantAnchor[], next: Anchor[]): TenantAnchor[] {
  const custom = new Map(copy.filter((a) => a.placementCustom).map((a) => [a.signal, a]));
  const merged: TenantAnchor[] = [...custom.values()];
  for (const a of next) {
    if (custom.has(a.signal)) continue;
    merged.push({ ...a, placementCustom: false });
  }
  return merged.sort((x, y) => x.signal.localeCompare(y.signal));
}
