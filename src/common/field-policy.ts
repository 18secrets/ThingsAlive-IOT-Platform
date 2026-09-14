import { SetMetadata } from '@nestjs/common';
import { RequestScope } from '../auth/types/request-scope';

export const FIELD_POLICY_KEY = 'ta:field-policy';

/**
 * Which roles may see a field. A field named here is removed for everyone else.
 */
export type FieldPolicy = Readonly<Record<string, readonly string[]>>;

/**
 * Declares the response fields a route restricts (task P1-55, decision 4).
 *
 * The four consumer roles see different things: a cost estimate belongs to a super
 * admin and an admin, not to an operator on a tablet; a raw model confidence belongs
 * to nobody outside Things Alive. The alternative — sending everything and hiding it
 * in the browser — is not a boundary. It is a rendering choice, and anyone can open
 * the network tab.
 *
 * Listing a field with `[]` removes it for every role, which is how a field stays in
 * the internal shape while never reaching a caller. There is no implicit exemption
 * for platform roles: if Things Alive support should see a field, its roles are named
 * like anyone else's.
 *
 *   @VisibleTo({ estimatedCost: ['super admin', 'admin'], modelConfidence: ['master-admin'] })
 */
export const VisibleTo = (policy: FieldPolicy) => SetMetadata(FIELD_POLICY_KEY, policy);

/**
 * Removes restricted fields from a response, at every depth.
 *
 * Applied to nested objects and array elements as well as the top level, because the
 * same field on a list item is the same field. Dates, buffers and other non-plain
 * objects are returned untouched — walking them would rewrite values rather than
 * filter them.
 */
export function applyFieldPolicy<T>(value: T, policy: FieldPolicy, scope: RequestScope): T {
  const allowed = new Set(scope.roles);
  const hidden = Object.entries(policy)
    .filter(([, roles]) => !roles.some((r) => allowed.has(r)))
    .map(([field]) => field);

  if (!hidden.length) return value;
  return strip(value, new Set(hidden)) as T;
}

function strip(value: unknown, hidden: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => strip(v, hidden));
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (hidden.has(key)) continue;
    out[key] = strip(v, hidden);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
