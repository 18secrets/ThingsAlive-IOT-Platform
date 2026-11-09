import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { Severity } from '../src/common/severity';
import { withTenantSession } from '../src/scope/tenant-session';
import { routeToEngineer } from '../src/service-roster/roster-routing';
import { buildRosterTemplate, ROSTER_COLUMNS, ROSTER_SHEET } from '../src/service-roster/roster-workbook';
import { ServiceRosterService } from '../src/service-roster/service-roster.service';
import { PredictionWorkRaiser } from '../src/work/services/prediction-work-raiser.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'ServiceRoster1764100000000';

/**
 * The service roster (Crompton U5): regions of sites, engineers in rank order, kept by
 * hand or from Excel, and a critical job routed to the right engineer.
 */
describeDb('service roster', () => {
  let owner: DataSource;
  let ds: DataSource;
  let roster: ServiceRosterService;
  const raiser = new PredictionWorkRaiser();

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
  const staff: RequestScope = { tenantId: '', userId: 'u-staff', roles: ['master-admin'], isPlatformRole: true };
  const ids: Record<string, string> = {};

  const sheet = async (rows: (string | number)[][]) => {
    const wb = new Workbook();
    const ws = wb.addWorksheet(ROSTER_SHEET);
    ws.addRow(Object.values(ROSTER_COLUMNS));
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const regionRows = () => owner.query(`SELECT count(*)::int AS n FROM service_region WHERE tenant_id = 'acme'`).then((r) => r[0].n as number);
  const raise = (externalId: string) => withTenantSession(ds, acme, (m) => raiser.raiseFromPrediction(m, acme, {
    sourceSystem: 'ta-2.0', externalId, predictionId: '00000000-0000-4000-8000-000000000001',
    clientScenarioSlug: 'pump-dry-run', severity: Severity.Critical, riskScore: 90, occurredAt: new Date('2026-11-09T10:00:00Z'),
  }));

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    roster = new ServiceRosterService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => {
    for (const t of ['work_order_event', 'work_order', 'work_order_counter', 'service_region', 'equipment_profile', 'app_user', 'plant']) {
      await owner.query(`DELETE FROM "${t}"`);
    }
    for (const [tenant, code] of [['acme', 'SITE-01'], ['acme', 'SITE-02'], ['acme', 'SITE-03'], ['globex', 'G-SITE']]) {
      ids[code] = (await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id`, [tenant, code]))[0].id;
    }
    for (const [tenant, email, status] of [
      ['acme', 'one@acme.test', 'active'], ['acme', 'two@acme.test', 'active'],
      ['acme', 'gone@acme.test', 'suspended'], ['acme', 'new@acme.test', 'invited'], ['globex', 'g@globex.test', 'active'],
    ]) {
      ids[email] = (await owner.query(
        `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status) VALUES ($1, $2, $2, 'operator', $3) RETURNING id`,
        [tenant, email, status]))[0].id;
    }
    for (const [machine, site] of [['PUMP-1', 'SITE-01'], ['PUMP-3', 'SITE-03']]) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, tier, readiness, plant_id)
         VALUES ('acme', 'ta-2.0', $1, 'basic', '{}', $2)`, [machine, ids[site]]);
    }
  });

  describe('by hand, a region at a time', () => {
    it('saves a region with its sites and its engineers, rank 1 first', async () => {
      const region = await roster.putRegion(acme, {
        code: 'PUNE-W', name: 'Pune West', siteCodes: ['SITE-01', 'SITE-02'],
        engineers: [{ email: 'two@acme.test', rank: 2 }, { email: 'one@acme.test', rank: 1 }],
      });
      expect(region.sites.map((s) => s.code)).toEqual(['SITE-01', 'SITE-02']);
      expect(region.engineers.map((e) => [e.email, e.rank])).toEqual([['one@acme.test', 1], ['two@acme.test', 2]]);
    });

    it('engineers without a rank take the next ones in the order given', async () => {
      const region = await roster.putRegion(acme, {
        code: 'PUNE-W', name: 'Pune West', siteCodes: [], engineers: [{ email: 'one@acme.test' }, { email: 'two@acme.test' }],
      });
      expect(region.engineers.map((e) => e.rank)).toEqual([1, 2]);
    });

    it('refuses an unknown site, a stranger, a suspended engineer, and says which', async () => {
      const attempt = roster.putRegion(acme, {
        code: 'PUNE-W', name: 'Pune West', siteCodes: ['NOPE'],
        engineers: [{ email: 'g@globex.test' }, { email: 'gone@acme.test' }],
      });
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      const errors = await attempt.then(() => [] as { message: string }[],
        (e: BadRequestException) => (e.getResponse() as { errors: { message: string }[] }).errors);
      expect(errors.map((e) => e.message).join(' | ')).toMatch(/No site NOPE.*g@globex.test is not a user.*gone@acme.test is suspended/);
      expect(await regionRows()).toBe(0);
    });

    it('refuses to take a site from another region rather than moving it silently', async () => {
      await roster.putRegion(acme, { code: 'A', name: 'A', siteCodes: ['SITE-01'], engineers: [] });
      await expect(roster.putRegion(acme, { code: 'B', name: 'B', siteCodes: ['SITE-01'], engineers: [] }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('is the account\'s own: staff are sent to the account', async () => {
      await expect(roster.list(staff)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('the database keeps it honest whoever writes', () => {
    beforeEach(async () => {
      await owner.query(`INSERT INTO service_region (tenant_id, code, name) VALUES ('acme', 'R1', 'R1')`);
    });

    it('refuses another account\'s site', async () => {
      await expect(owner.query(`INSERT INTO service_region_plant (tenant_id, plant_id, region_code) VALUES ('acme', $1, 'R1')`, [ids['G-SITE']]))
        .rejects.toThrow(/fk_service_region_plant_plant/);
    });

    it('refuses another account\'s user as an engineer', async () => {
      await expect(owner.query(`INSERT INTO service_region_engineer (tenant_id, region_code, user_id, rank) VALUES ('acme', 'R1', $1, 1)`, [ids['g@globex.test']]))
        .rejects.toThrow(/fk_service_region_engineer_user/);
    });

    it('refuses a site in two regions and two engineers at one rank', async () => {
      await owner.query(`INSERT INTO service_region (tenant_id, code, name) VALUES ('acme', 'R2', 'R2')`);
      await owner.query(`INSERT INTO service_region_plant (tenant_id, plant_id, region_code) VALUES ('acme', $1, 'R1')`, [ids['SITE-01']]);
      await expect(owner.query(`INSERT INTO service_region_plant (tenant_id, plant_id, region_code) VALUES ('acme', $1, 'R2')`, [ids['SITE-01']]))
        .rejects.toThrow(/pk_service_region_plant/);
      await owner.query(`INSERT INTO service_region_engineer (tenant_id, region_code, user_id, rank) VALUES ('acme', 'R1', $1, 1)`, [ids['one@acme.test']]);
      await expect(owner.query(`INSERT INTO service_region_engineer (tenant_id, region_code, user_id, rank) VALUES ('acme', 'R1', $1, 1)`, [ids['two@acme.test']]))
        .rejects.toThrow(/uq_service_region_engineer_rank/);
    });

    it('another account cannot read it', async () => {
      const seen = await withTenantSession(ds, { ...acme, tenantId: 'globex' }, (m) => m.query(`SELECT * FROM service_region`));
      expect(seen).toEqual([]);
    });
  });

  describe('from Excel', () => {
    const good = () => sheet([
      ['PUNE-W', 'Pune West', 'SITE-01, SITE-02', 'one@acme.test', 1],
      ['PUNE-W', '', '', 'two@acme.test', 2],
      ['NASIK', 'Nasik', 'SITE-03', 'new@acme.test', ''],
    ]);

    it('the template reads back: its example rows are checked like any other', async () => {
      const plan = await roster.planImport(acme, await buildRosterTemplate());
      expect(plan.regions.map((r) => r.code)).toEqual(['PUNE-W']);
      expect(plan.valid).toBe(false); // example.com engineers are nobody in this account
    });

    it('checking a file writes nothing and points every error at its row', async () => {
      const plan = await roster.planImport(acme, await sheet([
        ['PUNE-W', 'Pune West', 'SITE-01', 'one@acme.test', 1],
        ['PUNE-W', 'Pune East', '', 'one@acme.test', 2],
        ['NASIK', 'Nasik', 'SITE-01, SITE-404', 'nobody@acme.test', 'x'],
      ]));
      expect(plan.valid).toBe(false);
      expect(plan.errors.map((e) => [e.row, e.message.split(' ').slice(0, 3).join(' ')])).toEqual(expect.arrayContaining([
        [3, 'Region name "Pune'], [4, 'Rank "x" must'], [4, 'Site SITE-01 is'], [4, 'No site SITE-404'], [4, 'nobody@acme.test is not'],
        [3, 'one@acme.test is listed'],
      ]));
      expect(await regionRows()).toBe(0);
    });

    it('applying replaces the whole roster with the file\'s', async () => {
      await roster.putRegion(acme, { code: 'OLD', name: 'Old', siteCodes: [], engineers: [] });
      const plan = await roster.applyImport(acme, await good());
      expect(plan.regions).toEqual([
        { code: 'PUNE-W', name: 'Pune West', sites: 2, engineers: 2 },
        { code: 'NASIK', name: 'Nasik', sites: 1, engineers: 1 },
      ]);
      expect((await roster.list(acme)).map((r) => r.code)).toEqual(['NASIK', 'PUNE-W']);
    });

    it('a file with one bad row is refused whole, and the roster stays as it was', async () => {
      await roster.applyImport(acme, await good());
      await expect(roster.applyImport(acme, await sheet([['PUNE-W', 'Pune West', 'SITE-404', 'one@acme.test', 1]])))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(await regionRows()).toBe(2);
    });

    it('two uploads at once both settle, and the roster is the file once, not twice', async () => {
      const file = await good();
      const results = await Promise.allSettled([roster.applyImport(acme, file), roster.applyImport(acme, file)]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM service_region_engineer WHERE tenant_id = 'acme'`);
      expect(n).toBe(3);
    });
  });

  describe('routing a job', () => {
    beforeEach(async () => {
      await roster.putRegion(acme, {
        code: 'PUNE-W', name: 'Pune West', siteCodes: ['SITE-01'],
        engineers: [{ email: 'one@acme.test' }, { email: 'two@acme.test' }],
      });
    });

    it('a critical prediction on a machine in a region goes to its rank-1 engineer, and the history says why', async () => {
      const id = await raise('PUMP-1');
      const [order] = await owner.query(`SELECT assigned_to_user_id FROM work_order WHERE id = $1`, [id]);
      expect(order.assigned_to_user_id).toBe(ids['one@acme.test']);
      const events = await owner.query(`SELECT kind, note FROM work_order_event WHERE work_order_id = $1 ORDER BY "at", kind DESC`, [id]);
      expect(events.map((e: { kind: string }) => e.kind)).toEqual(['raised', 'assigned']);
      expect(events[1].note).toMatch(/region PUNE-W, rank 1/);
    });

    it('a suspended rank 1 is passed over for rank 2', async () => {
      await owner.query(`UPDATE app_user SET status = 'suspended' WHERE email = 'one@acme.test'`);
      const routed = await withTenantSession(ds, acme, (m) => routeToEngineer(m, 'acme', 'ta-2.0', 'PUMP-1'));
      expect(routed?.userId).toBe(ids['two@acme.test']);
    });

    it('a machine whose site is in no region is left unassigned, as before the roster', async () => {
      const id = await raise('PUMP-3');
      const [order] = await owner.query(`SELECT assigned_to_user_id FROM work_order WHERE id = $1`, [id]);
      expect(order.assigned_to_user_id).toBeNull();
    });
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    await undoMigrationNamed(owner, MIGRATION);
    const gone = await owner.query(`SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'service_region%'`);
    expect(gone).toHaveLength(0);
    await owner.runMigrations({ transaction: 'all' });
    const back = await owner.query(`SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'service_region%'`);
    expect(back).toHaveLength(3);
  });
});
