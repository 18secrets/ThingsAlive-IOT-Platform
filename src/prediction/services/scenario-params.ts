/**
 * A scenario's number, as the scorer reads it: the machine's own override, else the
 * scenario's declared default, else the scorer's fallback. One function, so the rule shown
 * to a person (`scenario-rule.ts`) and the rule the scorer runs read the same value.
 */
export function scenarioNumber(
  parameters: { key: string; default: unknown }[] | null | undefined,
  overrides: Record<string, unknown> | null | undefined,
  key: string,
  fallback: number,
): number {
  const value = overrides?.[key] ?? parameters?.find((p) => p.key === key)?.default;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}
