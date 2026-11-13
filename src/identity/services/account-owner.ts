import { ForbiddenException } from '@nestjs/common';
import { RequestScope } from '../../auth/types/request-scope';
import { Capability } from '../../auth/capabilities';

/**
 * Who may hand out power in an account (testing sheet TC_193–196, 13 Nov 2026).
 *
 * A custom role holding user.manage and role.manage — an "Admin" — could promote anyone,
 * itself included, to CEO / Manager, and was shown every page as if it were one. The
 * account's built-in CEO / Manager is its owner: only they change someone's role, and
 * only they grant a role that itself manages users or roles. Nobody changes their own.
 * Things Alive staff act above the account and are not held to it.
 */
export const ACCOUNT_OWNER_ROLE = 'ceo-manager';

export const isAccountOwner = (scope: RequestScope): boolean =>
  scope.isPlatformRole || scope.roles.includes(ACCOUNT_OWNER_ROLE);

/** A role that can itself manage people or roles: the owner's to grant, nobody else's. */
export const managesPeople = (role: { slug: string; capabilities: readonly Capability[] }): boolean =>
  role.slug === ACCOUNT_OWNER_ROLE
  || role.capabilities.includes('user.manage' as Capability)
  || role.capabilities.includes('role.manage' as Capability);

export function assertMayGrant(scope: RequestScope, role: { slug: string; name: string; capabilities: readonly Capability[] }): void {
  if (!isAccountOwner(scope) && managesPeople(role)) {
    throw new ForbiddenException(`Only a CEO / Manager can give someone the ${role.name} role.`);
  }
}
