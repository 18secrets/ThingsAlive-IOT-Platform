/**
 * The resolved authority for one request (task P1-51).
 *
 * Resolved exactly once, by the guard, from the verified token. Everything
 * downstream takes this object rather than re-deriving authority from a path
 * parameter or a request body — which is how the existing platform ended up
 * accepting a device_id from a caller who may not own that device.
 */
export interface RequestScope {
  /** The 2.0 tenant. Never read from the URL. */
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  /** Platform roles act across tenants and are audited when they do. */
  readonly isPlatformRole: boolean;
  /**
   * What this caller may do, resolved from their account's own role row.
   *
   * Present for a client user, absent for a platform role — platform roles are
   * Things Alive's and stay in the static table. When present it is the whole
   * answer: it is not merged with the table, because a merge would mean a client
   * could never take a capability away from one of their own roles.
   */
  readonly capabilities?: readonly string[];

  /** Empty array means "no assets of this kind"; undefined means "unrestricted within the tenant". */
  readonly plantIds?: readonly string[];
  readonly equipmentIds?: readonly string[];
  readonly deviceIds?: readonly string[];
}

export const REQUEST_SCOPE_KEY = 'taScope';

export function describeScope(scope: RequestScope): string {
  const bits = [`tenant=${scope.tenantId}`, `user=${scope.userId}`];
  if (scope.plantIds) bits.push(`plants=${scope.plantIds.length}`);
  if (scope.equipmentIds) bits.push(`equipment=${scope.equipmentIds.length}`);
  if (scope.isPlatformRole) bits.push('platform-role');
  return bits.join(' ');
}
