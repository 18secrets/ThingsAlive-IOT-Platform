import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';

/**
 * The role every scoped session runs as. Created by the RLS migration, NOLOGIN and
 * without BYPASSRLS, so nothing can connect as it and it cannot escape a policy.
 * The name is a literal rather than configuration: a session that silently fell back
 * to the login user would look identical and enforce nothing.
 */
export const APP_ROLE = 'ta_app';

/**
 * The bridge between the request's scope and the database's own isolation (P1-53).
 *
 * Row-level security on the tenant-owned tables reads `ta.tenant_id` from the
 * session. It is set here, with `set_config(..., true)`, which scopes it to the
 * current transaction — so it cannot leak to the next request that borrows the same
 * pooled connection. A connection-level `SET` would do exactly that, and the bug
 * would look like intermittent cross-tenant data.
 *
 * Anything that reaches the database outside this helper carries no setting at all.
 * `current_setting('ta.tenant_id', true)` then returns NULL, the policy matches
 * nothing, and the query returns nothing. That is the intended failure: an endpoint
 * that forgets its filter reads zero rows rather than everybody's.
 */
export async function withTenantSession<R>(
  ds: DataSource,
  scope: RequestScope,
  fn: (manager: EntityManager) => Promise<R>,
): Promise<R> {
  return withTenantId(ds, scope.tenantId, fn);
}

/**
 * The same session for internal work that has a tenant but no request behind it —
 * a scheduled job, a staleness check. It takes the tenant explicitly rather than a
 * fabricated scope, because a fake scope in the codebase is something someone will
 * eventually pass to an authorisation check.
 */
export async function withTenantId<R>(
  ds: DataSource,
  tenantId: string,
  fn: (manager: EntityManager) => Promise<R>,
): Promise<R> {
  return ds.transaction(async (manager) => {
    // Parameterised. `SET LOCAL` cannot take a bind parameter, so a tenant id from a
    // token would have to be interpolated into SQL; set_config() takes one.
    await manager.query(`SELECT set_config('ta.tenant_id', $1, true)`, [tenantId]);
    // Drop to the unprivileged role for the rest of the transaction.
    //
    // Without this the policy is decorative: a superuser — which is what a managed
    // Postgres hands out by default — bypasses row-level security unconditionally,
    // FORCE included. Reverts on commit or rollback, like everything LOCAL.
    await manager.query(`SET LOCAL ROLE "${APP_ROLE}"`);
    return fn(manager);
  });
}

/**
 * The one deliberate exemption: work that is legitimately tenant-spanning.
 *
 * Two callers, both deliberate. The sync and ingest paths write rows for many
 * tenants in a single pass — they are the producers of tenant data, not consumers of
 * it, and there is no single tenant whose session they could run under. The other is
 * `ScopedRepository.acrossTenants`, which requires a platform role and writes the
 * access to the audit log before it reads anything.
 *
 * This is the only place in the codebase that sets `ta.bypass`, and CI fails if that
 * setting appears anywhere else (see the `escape-hatch` job). An escape hatch that
 * can be copied is not an escape hatch; it is the new default.
 *
 * It is not a defence against a compromised database credential — anything holding
 * the connection could set the same value. It defends against the failure that
 * actually happens: application code that forgets its WHERE clause.
 */
export async function runTenantSpanning<R>(
  ds: DataSource,
  reason: string,
  fn: (manager: EntityManager) => Promise<R>,
): Promise<R> {
  const logger = new Logger('TenantSpanning');
  logger.debug(`Tenant-spanning transaction: ${reason}`);
  return ds.transaction(async (manager) => {
    await manager.query(`SELECT set_config('ta.bypass', 'on', true)`);
    return fn(manager);
  });
}

/**
 * The role an evaluation runs as (task QEVAL1a, G10). Created by the Evaluation
 * migration, NOLOGIN, and granted only what an evaluation reads plus its own two
 * tables — so an eval that reused shared code which writes a forecast, an alert or a
 * work order is refused by the database rather than trusted not to.
 */
export const EVAL_ROLE = 'ta_eval';

/**
 * An evaluation session: one account's (under its policy), every account's (through
 * `runTenantSpanning`, with its reason), or none — the platform-owned run ledger, which
 * has no tenant column. In every case the transaction then drops to `ta_eval`, which is
 * why this lives here: CI allows SET ROLE in this file and the migrations, nowhere else.
 */
export async function withEvalSession<R>(
  ds: DataSource,
  scope: { tenantId: string } | { spanning: string } | 'platform',
  fn: (manager: EntityManager) => Promise<R>,
): Promise<R> {
  const asEval = async (manager: EntityManager) => {
    await manager.query(`SET LOCAL ROLE "${EVAL_ROLE}"`);
    return fn(manager);
  };
  if (scope === 'platform') return ds.transaction(asEval);
  if ('tenantId' in scope) return withTenantId(ds, scope.tenantId, asEval);
  return runTenantSpanning(ds, `evaluation: ${scope.spanning}`, asEval);
}
