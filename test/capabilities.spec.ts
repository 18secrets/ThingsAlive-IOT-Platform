import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALL_CAPABILITIES, Capability, capabilitiesFor, can } from '../src/auth/capabilities';
import { CapabilityGuard } from '../src/auth/guards/capability.guard';
import { REQUEST_SCOPE_KEY, RequestScope } from '../src/auth/types/request-scope';

/**
 * The capability table, and the guard that enforces it (tasks P1-57, P1-58).
 *
 * The property worth protecting is that `/me/permissions` and the guard cannot
 * disagree. They read the same function, and the test below enforces that by
 * checking the guard's decision against the reported capability for every
 * capability and every role — not by re-implementing the rules and hoping the two
 * copies stay in step.
 */
describe('capabilities', () => {
  const scopeWith = (...roles: string[]): RequestScope => ({
    tenantId: 't1', userId: 'u1', roles, isPlatformRole: roles.includes('master-admin'),
  });

  const ROLES = [
    'super admin', 'admin', 'operational', 'support',
    'master-admin', 'catalog-author', 'platform-support',
  ];

  function guardFor(required: Capability | undefined) {
    const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
    return new CapabilityGuard(reflector);
  }

  const ctxWith = (scope?: RequestScope) => ({
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => (scope ? { [REQUEST_SCOPE_KEY]: scope } : {}) }),
  }) as unknown as ExecutionContext;

  it('the guard and /me/permissions never disagree', async () => {
    for (const role of ROLES) {
      const scope = scopeWith(role);
      const reported = capabilitiesFor(scope);
      for (const capability of ALL_CAPABILITIES) {
        const guard = guardFor(capability);
        let allowed = true;
        try {
          guard.canActivate(ctxWith(scope));
        } catch {
          allowed = false;
        }
        expect({ role, capability, allowed }).toEqual({
          role, capability, allowed: reported[capability],
        });
      }
    }
  });

  it('lets a route with no declared capability through', () => {
    // Most routes need authentication, not a capability. Requiring every route to
    // name one would push people towards a catch-all capability that means nothing.
    expect(guardFor(undefined).canActivate(ctxWith(scopeWith('operational')))).toBe(true);
  });

  it('refuses when a capability is required and nothing authenticated the caller', () => {
    // A public route running privileged work is the failure this prevents.
    expect(() => guardFor('catalog.write').canActivate(ctxWith(undefined)))
      .toThrow(ForbiddenException);
  });

  it('keeps the four consumer roles out of catalog authoring', () => {
    // The catalog is what Things Alive sells. A customer editing it would be editing
    // the product, and a tenant admin is not a Things Alive employee.
    for (const role of ['super admin', 'admin', 'operational', 'support']) {
      expect(can(scopeWith(role), 'catalog.write')).toBe(false);
      expect(can(scopeWith(role), 'entitlement.grant')).toBe(false);
    }
  });

  it('splits catalog.write from catalog.publish: master admin holds both, catalog-author only the first', () => {
    // Loading content stays broad; publishing a draft version so tenants can be
    // granted it is narrower (task QPA2).
    expect(can(scopeWith('master-admin'), 'catalog.write')).toBe(true);
    expect(can(scopeWith('master-admin'), 'catalog.publish')).toBe(true);
    expect(can(scopeWith('catalog-author'), 'catalog.write')).toBe(true);
    expect(can(scopeWith('catalog-author'), 'catalog.publish')).toBe(false);
  });

  it('lets every role inside a tenant read the catalog', () => {
    // What they see is narrowed by the entitlement join, not by the role. Those are
    // different questions, and conflating them is how a role silently grants access
    // to a class the customer never bought.
    for (const role of ['super admin', 'admin', 'operational', 'support']) {
      expect(can(scopeWith(role), 'catalog.read')).toBe(true);
    }
  });

  it('grants nothing at all to a caller with no roles', () => {
    const none = capabilitiesFor(scopeWith());
    expect(Object.values(none).every((v) => v === false)).toBe(true);
  });
});
