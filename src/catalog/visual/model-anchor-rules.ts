/** A marker on the class's 3-D model, in the model's own units (task QTWIN1). */
export interface ModelAnchor {
  signal: string;
  x: number;
  y: number;
  z: number;
  label: string | null;
}

export interface TenantModelAnchor extends ModelAnchor {
  /** The tenant moved or added it — never moved by a new class version. */
  placementCustom: boolean;
  /** The geometry changed under a marker the tenant placed: it waits in the tray until
   * someone confirms it (D39). */
  needsRecheck: boolean;
}

/** The model's bounding box, as the console measured it at confirm. */
export interface ModelBounds {
  min: [number, number, number];
  max: [number, number, number];
}

const AXES = ['x', 'y', 'z'] as const;

/**
 * Every reason a model anchor set is refused, each naming what — the schematic's rules
 * (anchor-rules.ts) with a box in place of 0–100. Outside the box is refused here so the
 * PUT can say which anchor; the database refuses it again for any other path.
 */
export function modelAnchorProblems(
  anchors: ModelAnchor[], declaredSignals: Iterable<string>, bounds: ModelBounds | null,
): string[] {
  const declared = new Set(declaredSignals);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const a of anchors) {
    if (seen.has(a.signal)) problems.push(`signal "${a.signal}" has more than one model anchor.`);
    seen.add(a.signal);
    if (!declared.has(a.signal)) problems.push(`model anchor for signal "${a.signal}", which the class does not declare.`);
    AXES.forEach((axis, i) => {
      const v = a[axis];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        problems.push(`model anchor for "${a.signal}" has ${axis} ${v}; it must be a finite number.`);
      } else if (bounds && (v < bounds.min[i] || v > bounds.max[i])) {
        problems.push(
          `model anchor for "${a.signal}" has ${axis} ${v}, outside the model's bounds (${bounds.min[i]} to ${bounds.max[i]}).`,
        );
      }
    });
  }
  return problems;
}

/** Two boxes are the same geometry only if every face is where it was. */
export const sameBounds = (a: ModelBounds | null, b: ModelBounds | null): boolean =>
  !!a && !!b && a.min.every((v, i) => v === b.min[i]) && a.max.every((v, i) => v === b.max[i]);

/**
 * The tray beside the 3-D twin: every declared signal with no marker on the model, and
 * every marker waiting for a recheck. A recheck marker is not drawn on the model —
 * "we did not move your marker" is not reassuring if the machine under it moved (D39).
 */
export function modelTray(
  declaredSignals: string[], anchors: Pick<TenantModelAnchor, 'signal' | 'needsRecheck'>[],
): { signal: string; needsRecheck: boolean }[] {
  const recheck = new Set(anchors.filter((a) => a.needsRecheck).map((a) => a.signal));
  const placed = new Set(anchors.filter((a) => !a.needsRecheck).map((a) => a.signal));
  return [
    ...declaredSignals.filter((s) => !placed.has(s) && !recheck.has(s)).map((signal) => ({ signal, needsRecheck: false })),
    ...[...recheck].sort().map((signal) => ({ signal, needsRecheck: true })),
  ];
}

/**
 * A tenant's model anchors carried onto a new class version — QREC0c's merge rule
 * (`mergeTenantAnchors`), with the geometry rule on top:
 *
 *  - a class-origin anchor takes the new version's position and label;
 *  - a tenant-placed anchor keeps its position whatever the new version says, and is
 *    marked `needsRecheck` when the geometry changed — or stays marked if it already was;
 *  - a class-origin anchor the new version no longer has is dropped;
 *  - a new class anchor arrives for any signal the tenant has not placed.
 */
export function mergeTenantModelAnchors(
  copy: TenantModelAnchor[], next: ModelAnchor[], geometryChanged: boolean,
): TenantModelAnchor[] {
  const custom = new Map(copy.filter((a) => a.placementCustom).map((a) => [a.signal, a]));
  const merged: TenantModelAnchor[] = [...custom.values()].map((a) => ({ ...a, needsRecheck: a.needsRecheck || geometryChanged }));
  for (const a of next) {
    if (custom.has(a.signal)) continue;
    merged.push({ ...a, placementCustom: false, needsRecheck: false });
  }
  return merged.sort((x, y) => x.signal.localeCompare(y.signal));
}
