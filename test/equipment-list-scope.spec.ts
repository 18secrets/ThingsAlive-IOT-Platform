import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { EquipmentService } from '../src/equipment/services/equipment.service';
import { ScopeResolverService } from '../src/identity/services/scope-resolver.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * The equipment register lists only the machines the caller is assigned to.
 *
 * `EquipmentService.list` filtered by account and nothing else, so a site manager or an
 * operator saw every machine in the account on the equipment screen — and so did the
 * assistant's `list_equipment` tool, which reads through the same method. Found while
 * building Vani's analysis tool (plan Phase 6), where it meant a caller assigned to one
 * generator could hear about the others. Every other list (alerts, incidents, work)
 * already narrowed to the assignment; this one now does too.
 *
 * Scopes come from the real resolver, so the test proves the shapes a signed-in person
 * actually gets — site-shaped access derived from the site, machine-shaped access from
 * the assignment rows — not shapes written by hand to match the fix.
 */
describeDb('equipment register: only your machines', () => {
  let owner: DataSource;
  let ds: DataSource;
  let equipment: EquipmentService;
  let resolver: ScopeResolverService;
  const ids: Record<string, string> = {};
  const plant: Record<string, string> = {};
  const SRC = 'ta-2.0';

  const scopeOf = async (key: string): Promise<RequestScope> => {
    const r = (await resolver.resolve('acme', ids[key]))!;
    return {
      tenantId: 'acme', userId: ids[key], isPlatformRole: false, roles: r.roles,
      capabilities: r.capabilities, plantIds: r.plantIds, equipmentIds: r.equipmentIds,
    };
  };
  const codes = async (scope: RequestScope, filters = {}) =>
    (await equipment.list(scope, filters)).map((e) => e.externalId);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    equipment = new EquipmentService(ds);
    resolver = new ScopeResolverService(ds);

    for (const code of ['NORTH', 'SOUTH']) {
      const [p] = await owner.query(
        `INSERT INTO plant (tenant_id, code, name) VALUES ('acme', $1, $1) RETURNING id`, [code]);
      plant[code] = p.id;
    }
    for (const [ext, site] of [['M1', 'NORTH'], ['M2', 'NORTH'], ['M3', 'SOUTH']]) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness, plant_id)
           VALUES ('acme', $1, $2, $2, 'client', 'active', 'basic', '{}'::jsonb, $3)`, [SRC, ext, plant[site]]);
    }
    for (const [slug, shape] of [['admin', 'tenant'], ['site-manager', 'plant'], ['operator', 'equipment']]) {
      await owner.query(
        `INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape) VALUES ('acme', $1, $1, '{catalog.read}'::text[], $2)`,
        [slug, shape]);
    }
    for (const [key, role] of [['ada', 'admin'], ['nina', 'site-manager'], ['olga', 'operator'], ['otto', 'operator']]) {
      const [u] = await owner.query(
        `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status) VALUES ('acme', $1, $2, $3, 'active') RETURNING id`,
        [`${key}@acme.test`, key, role]);
      ids[key] = u.id;
    }
    await owner.query(`INSERT INTO user_plant_access (tenant_id, user_id, plant_id) VALUES ('acme', $1, $2)`, [ids.nina, plant.NORTH]);
    await owner.query(
      `INSERT INTO user_equipment_access (tenant_id, user_id, source_system, equipment_external_id) VALUES ('acme', $1, $2, 'M3')`,
      [ids.olga, SRC]);
    // otto is an operator assigned to nothing.
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  it('shows the whole register to somebody who sees the whole account', async () => {
    expect(await codes(await scopeOf('ada'))).toEqual(['M1', 'M2', 'M3']);
  });

  it('shows a site manager the machines at their site, and no others', async () => {
    expect(await codes(await scopeOf('nina'))).toEqual(['M1', 'M2']);
  });

  it('shows an operator the machines they are assigned to, and no others', async () => {
    expect(await codes(await scopeOf('olga'))).toEqual(['M3']);
  });

  it('shows somebody assigned to nothing, nothing — not everything', async () => {
    expect(await codes(await scopeOf('otto'))).toEqual([]);
  });

  it('keeps the narrowing when a site is asked for', async () => {
    // Nina asking for the site she is not assigned to gets nothing from it.
    expect(await codes(await scopeOf('nina'), { plantId: plant.SOUTH })).toEqual([]);
    expect(await codes(await scopeOf('nina'), { plantId: plant.NORTH })).toEqual(['M1', 'M2']);
  });
});
