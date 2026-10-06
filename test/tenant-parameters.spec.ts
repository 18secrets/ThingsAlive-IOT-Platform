import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { capabilitiesFor } from '../src/auth/capabilities';
import { ClientFormula } from '../src/client-catalog/entities/client-formula.entity';
import { COST_PARAMETER_NAMES } from '../src/parameters/parameter-catalog';
import { ParameterRow, resolveFromRows, resolveParameters } from '../src/parameters/services/parameter-resolution';
import { ParameterService } from '../src/parameters/services/parameter.service';
import { runTenantSpanning, withTenantId } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'TenantParameters1758400000000';

/**
 * Client parameters and cost profiles (task QPARAM1).
 *
 * Resolution is pure and tested as such. Everything that protects the data — append-
 * only, a value's shape, currency at client scope only, the currency guard — is a
 * database rule, and each is asserted by attempting the thing it forbids.
 */
describe('tenant parameters: resolution (pure)', () => {
  const T0 = new Date('2026-01-01T00:00:00Z');
  const row = (scope: ParameterRow['scope'], scopeRef: string | null, name: string, value: unknown): ParameterRow => ({
    scope, scopeRef, name, value, unit: null, effectiveFrom: T0,
  });
  const chain = { equipment: 'eq-1', equipment_class: 'genset', site: 'plant-1' };

  it('each level wins over the one above it', () => {
    const rows = [
      row('client', null, 'fuel_price', 1),
      row('site', 'plant-1', 'fuel_price', 2),
      row('equipment_class', 'genset', 'fuel_price', 3),
      row('equipment', 'eq-1', 'fuel_price', 4),
    ];
    for (let n = 1; n <= 4; n += 1) {
      // Drop the most specific rows one at a time: the next level up answers each time.
      const visible = rows.slice(0, n);
      expect(resolveFromRows(visible, chain, ['fuel_price']).get('fuel_price')?.value).toBe(n);
    }
  });

  it('resolves per field — one machine inherits two fields from two different levels at once', () => {
    const resolved = resolveFromRows([
      row('site', 'plant-1', 'fuel_price', 92),
      row('equipment', 'eq-1', 'operating_cost_per_hour', 1500),
    ], chain, ['fuel_price', 'operating_cost_per_hour']);
    // The machine's override of one field must not blank the site's other one.
    expect(resolved.get('fuel_price')).toMatchObject({ value: 92, source: { scope: 'site', scopeRef: 'plant-1' } });
    expect(resolved.get('operating_cost_per_hour')).toMatchObject({
      value: 1500, source: { scope: 'equipment', scopeRef: 'eq-1' },
    });
  });

  it('a cleared scope says nothing, so the next scope up answers', () => {
    const resolved = resolveFromRows([
      row('client', null, 'fuel_price', 90),
      row('equipment', 'eq-1', 'fuel_price', null),
    ], chain, ['fuel_price']);
    expect(resolved.get('fuel_price')).toMatchObject({ value: 90, source: { scope: 'client' } });
  });

  it('a value set nowhere resolves to null, not to 0', () => {
    expect(resolveFromRows([], chain, ['fuel_price']).get('fuel_price')).toBeNull();
  });

  it('a row for some other machine or site is never picked up', () => {
    const resolved = resolveFromRows([
      row('equipment', 'eq-2', 'fuel_price', 1), row('site', 'plant-2', 'fuel_price', 2),
    ], chain, ['fuel_price']);
    expect(resolved.get('fuel_price')).toBeNull();
  });

  it('no platform role can read or write parameters', () => {
    for (const role of ['master-admin', 'catalog-author', 'platform-support']) {
      const caps = capabilitiesFor({ tenantId: 't', userId: 'u', roles: [role], isPlatformRole: true });
      expect({ role, read: caps['parameters.read'], write: caps['parameters.write'] })
        .toEqual({ role, read: false, write: false });
    }
  });
});

describeDb('tenant parameters: schema and service', () => {
  let owner: DataSource;
  let ds: DataSource;
  let service: ParameterService;
  let plantA: string;
  let plantB: string;
  let equipmentId: string;

  const TENANT = 'acme';
  const OTHER = 'globex';
  const boss: RequestScope = { tenantId: TENANT, userId: 'u-boss', roles: ['super admin'], isPlatformRole: false };
  const NOW = new Date('2026-10-01T00:00:00Z');

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    service = new ParameterService(ds);

    [{ id: plantA }] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name) VALUES ($1, 'P-A', 'Plant A') RETURNING id`, [TENANT],
    );
    [{ id: plantB }] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name) VALUES ($1, 'P-B', 'Plant B') RETURNING id`, [TENANT],
    );
    [{ id: equipmentId }] = await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, equipment_class_slug, plant_id)
       VALUES ($1, 'ta-2.0', 'DG-1', 'genset', $2) RETURNING id`, [TENANT, plantA],
    );
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  // TRUNCATE, not DELETE: the table refuses DELETE for everyone, which is the point.
  beforeEach(async () => { await owner.query(`TRUNCATE "tenant_parameter"`); });

  const insert = (over: Record<string, unknown> = {}) => {
    const r = {
      tenant_id: TENANT, scope: 'client', scope_ref: null, name: 'fuel_price', value: '92',
      unit: 'currency/L', effective_from: NOW, created_by: 'u-boss', ...over,
    } as Record<string, unknown>;
    const cols = Object.keys(r);
    return owner.query(
      `INSERT INTO tenant_parameter (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      Object.values(r),
    );
  };

  describe('the history cannot be rewritten', () => {
    it('refuses UPDATE, even for the owner', async () => {
      await insert();
      await expect(owner.query(`UPDATE tenant_parameter SET value = '1'`)).rejects.toThrow(/tenant_parameter_append_only/);
    });

    it('refuses DELETE, even for the owner', async () => {
      await insert();
      await expect(owner.query(`DELETE FROM tenant_parameter`)).rejects.toThrow(/tenant_parameter_append_only/);
    });

    it('refuses a second row for the same scope, name and instant', async () => {
      await insert();
      await expect(insert({ value: '93' })).rejects.toThrow(/uq_tenant_parameter_version/);
    });

    it('refuses two client rows at the same instant — a NULL scope_ref is not a way round the index', async () => {
      await insert({ scope_ref: null });
      await expect(insert({ scope_ref: null, value: '1' })).rejects.toThrow(/uq_tenant_parameter_version/);
    });
  });

  describe('the database refuses a value of the wrong shape', () => {
    it('refuses a currency anywhere but client scope', async () => {
      await expect(insert({ scope: 'site', scope_ref: plantA, name: 'currency', value: '"INR"', unit: null }))
        .rejects.toThrow(/ck_tenant_parameter_currency_scope/);
    });

    it('refuses a currency that is not an ISO 4217 code', async () => {
      await expect(insert({ name: 'currency', value: '"rupees"', unit: null })).rejects.toThrow(/ck_tenant_parameter_value/);
    });

    it('refuses a string where a number belongs', async () => {
      await expect(insert({ value: '"ninety-two"' })).rejects.toThrow(/ck_tenant_parameter_value/);
    });

    it('refuses a zero or fractional stale_after_seconds', async () => {
      await expect(insert({ name: 'stale_after_seconds', value: '0', unit: 's' })).rejects.toThrow(/ck_tenant_parameter_value/);
      await expect(insert({ name: 'stale_after_seconds', value: '1.5', unit: 's' })).rejects.toThrow(/ck_tenant_parameter_value/);
    });

    it('refuses a site value that does not say which site', async () => {
      await expect(insert({ scope: 'site', scope_ref: null })).rejects.toThrow(/ck_tenant_parameter_scope_ref/);
    });

    it('accepts JSON null as a deliberate clear', async () => {
      await expect(insert({ value: 'null' })).resolves.toBeDefined();
    });
  });

  it('the database and the catalog agree on which parameters are cost-typed', async () => {
    const [{ names }] = await owner.query(`SELECT tenant_parameter_cost_names() AS names`);
    expect([...names].sort()).toEqual([...COST_PARAMETER_NAMES].sort());
  });

  it('isolates tenants: one account cannot see, or write, another\'s cost data', async () => {
    await insert();
    const seen = await withTenantId(ds, OTHER, (m) => m.query(`SELECT * FROM tenant_parameter`));
    expect(seen).toHaveLength(0);
    await expect(withTenantId(ds, OTHER, (m) => m.query(
      `INSERT INTO tenant_parameter (tenant_id, scope, name, value, effective_from, created_by)
       VALUES ($1, 'client', 'fuel_price', '1', now(), 'intruder')`, [TENANT],
    ))).rejects.toThrow(/row-level security/);
  });

  describe('resolution against the database', () => {
    it('a value effective tomorrow does not apply today', async () => {
      await service.set(boss, { scope: 'client', name: 'fuel_price', value: 90, effectiveFrom: new Date('2026-01-01') });
      await service.set(boss, { scope: 'client', name: 'fuel_price', value: 95, effectiveFrom: new Date('2026-10-02') });
      const at = (d: string) => withTenantId(ds, TENANT, (m) => resolveParameters(
        m, TENANT, { equipment: equipmentId, equipment_class: 'genset', site: plantA }, ['fuel_price'], new Date(d),
      ));
      expect((await at('2026-10-01T12:00:00Z')).get('fuel_price')?.value).toBe(90);
      expect((await at('2026-10-02T00:00:00Z')).get('fuel_price')?.value).toBe(95);
    });

    it('reports the source correctly at each level', async () => {
      const from = new Date('2026-01-01');
      await service.set(boss, { scope: 'client', name: 'fuel_price', value: 1, effectiveFrom: from });
      await service.set(boss, { scope: 'site', scopeRef: plantA, name: 'labour_rate_per_hour', value: 2, effectiveFrom: from });
      await service.set(boss, { scope: 'equipment', scopeRef: equipmentId, name: 'operating_cost_per_hour', value: 3, effectiveFrom: from });
      const values = await service.effective(boss, { scope: 'equipment', scopeRef: equipmentId }, NOW);
      const byName = new Map(values.map((v) => [v.name, v]));
      expect(byName.get('fuel_price')?.source).toEqual({ scope: 'client', scopeRef: null, effectiveFrom: from.toISOString() });
      expect(byName.get('labour_rate_per_hour')?.source).toEqual({ scope: 'site', scopeRef: plantA, effectiveFrom: from.toISOString() });
      expect(byName.get('operating_cost_per_hour')?.source).toEqual({
        scope: 'equipment', scopeRef: equipmentId, effectiveFrom: from.toISOString(),
      });
      expect(byName.get('stale_after_seconds')).toMatchObject({ value: null, source: null });
    });
  });

  describe('the closed set of names', () => {
    it('refuses a value for a name nothing declares, naming it', async () => {
      await expect(service.set(boss, { scope: 'client', name: 'fuel_prise', value: 92 }))
        .rejects.toThrow(/"fuel_prise".*unknown_parameter/);
    });

    it('accepts a name a formula declares, and the catalog says which formula needs it', async () => {
      await runTenantSpanning(owner, 'test fixture', async (m) => {
        await m.query(`DELETE FROM client_formula`);
        await m.getRepository(ClientFormula).save({
          tenantId: TENANT, clientEquipmentClassSlug: 'genset', formulaKey: 'derated_load',
          kind: 'empirical', expression: 'avg(load_pct) * @derate_factor',
          compiledPlan: null, compiledAt: null, compilerVersion: null, resultUnit: null,
          requiredSignals: ['load_pct'], requiredParameters: ['derate_factor'], bindings: [], resultKind: 'scalar',
          displayUnit: null, displayFormat: 'number:1', targetValue: null, targetMin: null, targetMax: null,
          targetDirection: 'none', comparisonBasis: 'none', aggregationWindow: '24h', chartType: 'none',
          templateVersion: 1, copiedAt: NOW, status: 'active', updatedBy: 'u-master',
        } as Partial<ClientFormula>);
      });
      const catalog = await service.catalog(boss);
      expect(catalog.find((c) => c.name === 'derate_factor')).toMatchObject({
        source: 'formula', requiredBy: [{ classSlug: 'genset', formulaKey: 'derated_load' }],
      });
      await expect(service.set(boss, { scope: 'client', name: 'derate_factor', value: 0.9 })).resolves.toBeDefined();
    });

    it('refuses a unit that disagrees with the declared one', async () => {
      await expect(service.set(boss, { scope: 'client', name: 'fuel_price', value: 92, unit: 'currency/gal' }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses setting the currency through the ordinary endpoint', async () => {
      await expect(service.set(boss, { scope: 'client', name: 'currency', value: 'USD' }))
        .rejects.toThrow(/parameters\/currency/);
    });
  });

  describe('changing the currency (§0.3)', () => {
    it('allows the first currency, and a change while no cost value exists', async () => {
      expect(await service.setCurrency(boss, 'INR', new Date('2026-01-01'))).toMatchObject({ currency: 'INR', changed: true });
      expect(await service.setCurrency(boss, 'USD', new Date('2026-02-01'))).toMatchObject({ currency: 'USD', changed: true });
    });

    it('refuses a change while cost values exist, naming how many and at which scopes', async () => {
      await service.setCurrency(boss, 'INR', new Date('2026-01-01'));
      await service.set(boss, { scope: 'client', name: 'fuel_price', value: 92 });
      await service.set(boss, { scope: 'site', scopeRef: plantA, name: 'fuel_price', value: 94 });
      await service.set(boss, { scope: 'site', scopeRef: plantB, name: 'labour_rate_per_hour', value: 400 });
      const attempt = service.setCurrency(boss, 'USD');
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(/3 cost value\(s\) exist \(1 at client, 2 at site\)/);
    });

    it('allows the change once the client has cleared them — and the clears stay in the history', async () => {
      await service.setCurrency(boss, 'INR', new Date('2026-01-01'));
      await service.set(boss, { scope: 'client', name: 'fuel_price', value: 92, effectiveFrom: new Date('2026-02-01') });
      await service.set(boss, { scope: 'client', name: 'fuel_price', value: null, effectiveFrom: new Date('2026-03-01') });
      await expect(service.setCurrency(boss, 'USD')).resolves.toMatchObject({ changed: true });
      const history = await service.history(boss, 'fuel_price');
      expect(history.map((h) => h.value)).toEqual([null, 92]);
    });

    it('the database refuses the change even when the service is bypassed', async () => {
      await insert({ name: 'currency', value: '"INR"', unit: null, effective_from: new Date('2026-01-01') });
      await insert({ name: 'fuel_price', value: '92' });
      await expect(insert({ name: 'currency', value: '"USD"', unit: null, effective_from: new Date('2026-10-02') }))
        .rejects.toThrow(/currency_conflict/);
    });

    it('re-stating the current currency writes nothing', async () => {
      await service.setCurrency(boss, 'INR');
      expect(await service.setCurrency(boss, 'INR')).toMatchObject({ currency: 'INR', changed: false });
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM tenant_parameter WHERE name = 'currency'`);
      expect(n).toBe(1);
    });

    it('two identical currency requests fired together both settle, and write once', async () => {
      const results = await Promise.allSettled([service.setCurrency(boss, 'INR'), service.setCurrency(boss, 'INR')]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM tenant_parameter WHERE name = 'currency'`);
      expect(n).toBe(1);
    });
  });

  describe('who can reach it', () => {
    it('refuses a platform role at the service, whatever its capabilities', async () => {
      const platform: RequestScope = { tenantId: TENANT, userId: 'u-ta', roles: ['master-admin'], isPlatformRole: true };
      await expect(service.catalog(platform)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.set(platform, { scope: 'client', name: 'fuel_price', value: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a site-scoped caller cannot read another site\'s values', async () => {
      await service.set(boss, { scope: 'site', scopeRef: plantB, name: 'fuel_price', value: 1 });
      const siteManager: RequestScope = { ...boss, userId: 'u-site', roles: ['site-manager'], plantIds: [plantA], equipmentIds: ['DG-1'] };
      await expect(service.effective(siteManager, { scope: 'site', scopeRef: plantB })).rejects.toBeInstanceOf(NotFoundException);
      expect(await service.history(siteManager, 'fuel_price')).toHaveLength(0);
      await expect(service.effective(siteManager, { scope: 'site', scopeRef: plantA })).resolves.toBeDefined();
    });

    it('refuses a ref that is not in this account', async () => {
      await expect(service.set(boss, { scope: 'equipment', scopeRef: '00000000-0000-0000-0000-000000000000', name: 'fuel_price', value: 1 }))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // Last: it takes the table away. Seeded before migrating, so the migration is proven
  // against an account that already has plants and machines, not an empty database.
  it(`${MIGRATION} runs down and up again over existing data`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const [{ exists: gone }] = await owner.query(`SELECT to_regclass('tenant_parameter') IS NOT NULL AS exists`);
    expect(gone).toBe(false);
    const [{ n: functions }] = await owner.query(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'tenant_parameter%'`,
    );
    expect(functions).toBe(0);

    await owner.runMigrations({ transaction: 'all' });
    await expect(insert()).resolves.toBeDefined();
  });
});
