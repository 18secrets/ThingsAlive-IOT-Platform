import { RequestScope } from '../src/auth/types/request-scope';
import { applyFieldPolicy } from '../src/common/field-policy';

/**
 * Field-level response policy (task P1-55, decision 4).
 *
 * The assertions are on the payload, not on a rendered screen. A field hidden by CSS
 * is still in the response, and the response is what an ordinary browser devtools
 * panel shows — so "the operator cannot see the cost" has to be true of the JSON.
 */
describe('field policy', () => {
  const scopeWith = (...roles: string[]): RequestScope => ({
    tenantId: 't1', userId: 'u1', roles, isPlatformRole: false,
  });

  const policy = {
    estimatedCost: ['super admin', 'admin'],
    modelConfidence: ['master-admin'],
    internalNote: [] as string[],
  };

  const body = {
    id: 'p-1',
    risk: 0.82,
    estimatedCost: 1450,
    modelConfidence: 0.61,
    internalNote: 'threshold fudged for the demo',
  };

  it('keeps a field for a role that may see it', () => {
    const out = applyFieldPolicy(body, policy, scopeWith('admin')) as any;
    expect(out.estimatedCost).toBe(1450);
    expect(out.risk).toBe(0.82);
  });

  it('removes the field entirely rather than blanking it', () => {
    // Null or "***" would still tell a caller the field exists and, often, that it
    // has a value. Absence is the only redaction that says nothing.
    const out = applyFieldPolicy(body, policy, scopeWith('operational')) as any;
    expect('estimatedCost' in out).toBe(false);
    expect('modelConfidence' in out).toBe(false);
    expect(out.risk).toBe(0.82);
  });

  it('gives a platform role no implicit exemption', () => {
    // Support sees what support is listed for. A blanket bypass would make every
    // policy in the codebase read as a suggestion.
    const support: RequestScope = { ...scopeWith('platform-support'), isPlatformRole: true };
    const out = applyFieldPolicy(body, policy, support) as any;
    expect('estimatedCost' in out).toBe(false);
  });

  it('hides a field listed with no roles from everyone', () => {
    for (const role of ['super admin', 'admin', 'operational', 'support', 'master-admin']) {
      const out = applyFieldPolicy(body, policy, scopeWith(role)) as any;
      expect('internalNote' in out).toBe(false);
    }
  });

  it('applies to list items and nested objects, not only the top level', () => {
    // The same field on a list row is the same field. A policy that only filtered the
    // envelope would leak on every paginated endpoint, which is most of them.
    const page = {
      items: [{ ...body }, { ...body, id: 'p-2' }],
      meta: { summary: { estimatedCost: 2900 } },
    };
    const out = applyFieldPolicy(page, policy, scopeWith('operational')) as any;
    expect(out.items).toHaveLength(2);
    for (const item of out.items) expect('estimatedCost' in item).toBe(false);
    expect('estimatedCost' in out.meta.summary).toBe(false);
  });

  it('leaves dates and other non-plain values intact', () => {
    // Walking a Date would rewrite it into an empty object, which is a data bug
    // wearing a security control's clothes.
    const at = new Date('2026-01-01T00:00:00Z');
    const out = applyFieldPolicy({ at, estimatedCost: 1 }, policy, scopeWith('operational')) as any;
    expect(out.at).toBeInstanceOf(Date);
    expect(out.at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns the body untouched when the caller may see everything', () => {
    const all = { estimatedCost: ['admin'], modelConfidence: ['admin'] };
    const out = applyFieldPolicy(body, all, scopeWith('admin'));
    expect(out).toBe(body);
  });
});
