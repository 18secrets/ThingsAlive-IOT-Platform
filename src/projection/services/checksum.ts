import { createHash } from 'crypto';

/**
 * A stable content hash for a projected record.
 *
 * Key order must not change the result, or every sync rewrites every row and the
 * "did anything actually change" question becomes unanswerable. Undefined values are
 * dropped so that an absent field and an explicitly-undefined one hash the same.
 */
export function checksumOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
