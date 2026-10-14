import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { PageService } from '../src/page/page.service';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { createTestDataSource, describeDb } from './db';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const SRC = 'iot-platform-1';
const acme: RequestScope = { tenantId: 'acme', userId: 'u', roles: ['admin'], isPlatformRole: false };

/**
 * The site page, batched (task QTX1). It cost about six queries per machine — each
 * machine's coverage, for `machine_list` — fine at 20 machines and seconds at 200. The
 * batch must give exactly the answer the per-machine path gave, machine by machine,
 * across every awkward case; and the page must stop growing six queries per machine.
 */
describeDb('site page: batched across machines', () => {
  let owner: DataSource;
  let app: INestApplication;
  let pages: PageService;
  let bindings: SignalBindingService;
  let plantId: string;

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-qtx1';
    process.env.AUTH_JWT_ISSUER = 'things-alive-qtx1-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    pages = app.get(PageService);
    bindings = app.get(SignalBindingService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  const machine = async (id: string, cls: string | null, signals: { role: string; count?: number; agoMinutes?: number | null }[]) => {
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, equipment_class_slug, class_version, plant_id, tier, readiness, updated_by)
         VALUES ('acme', $1, $2, $3, $4, $5, 'standard', '{}'::jsonb, 'u')`, [SRC, id, cls, cls ? 1 : null, plantId],
    );
    for (const s of signals) {
      for (let k = 0; k < (s.count ?? 1); k += 1) {
        const imei = `${id}-${s.role}-${k}`;
        await owner.query(
          `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role, component_id,
             origin, imei, channel, canonical_unit, valid_from, is_primary, status, discovered_by, approved_by, approved_at)
           VALUES ('acme', $1, $2, $3, $6, '', 'physical', $4, $5, 'x', '2026-01-01', true, 'active', 'manual', 'u', '2026-01-01')`,
          // Two sensors on one role (min_count 2): two primary bindings, one role, two keys.
          [SRC, id, `${s.role}${k ? `-${k}` : ''}`, imei, `ch${k}`, s.role],
        );
        if (s.agoMinutes !== null) {
          const at = new Date(NOW.getTime() - (s.agoMinutes ?? 1) * 60_000);
          await owner.query(
            `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, source_timestamp, received_at, source)
               VALUES ('acme', $1, $2, 1, $3, $3, 'live')`, [imei, s.role, at],
          );
        }
      }
    }
  };

  beforeAll(async () => {
    await owner.query(`SELECT ensure_telemetry_partition('2026-10-01'::date)`);
    [{ id: plantId }] = await owner.query(`INSERT INTO plant (tenant_id, code, name) VALUES ('acme', 'yard', 'Yard') RETURNING id`);
    for (const [cls, roles] of [['gen', ['coolant', 'oil']], ['pump', ['flow']]] as [string, string[]][]) {
      await owner.query(
        `INSERT INTO equipment_class_profile (slug, version, name, status, expected_signals) VALUES ($1, 1, $1, 'published', $2::jsonb)`,
        [cls, JSON.stringify(roles.map((r) => ({ signal: r, unit: 'x', required: true })))],
      );
      for (const role of roles) {
        await owner.query(
          `INSERT INTO equipment_class_sensor_requirement (class_slug, class_version, measurement_role, canonical_unit, min_count, stale_after_seconds)
             VALUES ($1, 1, $2, 'x', $3, 900)`, [cls, role, role === 'oil' ? 2 : 1],
        );
      }
    }
    await machine('FULL', 'gen', [{ role: 'coolant' }, { role: 'oil', count: 2 }]);
    await machine('PARTIAL', 'gen', [{ role: 'coolant' }, { role: 'oil', count: 1 }]);
    await machine('UNBOUND', 'gen', [{ role: 'coolant' }]);
    await machine('STALE', 'gen', [{ role: 'coolant', agoMinutes: 120 }, { role: 'oil', count: 2 }]);
    await machine('SILENT', 'gen', [{ role: 'coolant', agoMinutes: null }, { role: 'oil', count: 2, agoMinutes: null }]);
    await machine('PUMP', 'pump', [{ role: 'flow' }]);
    await machine('BARE', null, []);
    // This one machine is allowed four hours before its signals count as stale.
    await machine('PATIENT', 'gen', [{ role: 'coolant', agoMinutes: 120 }, { role: 'oil', count: 2 }]);
    const [{ id: patient }] = await owner.query(`SELECT id FROM equipment_profile WHERE external_id = 'PATIENT'`);
    await owner.query(
      `INSERT INTO tenant_parameter (tenant_id, scope, scope_ref, name, value, unit, effective_from, created_by)
         VALUES ('acme', 'equipment', $1, 'stale_after_seconds', '14400'::jsonb, 's', '2026-01-01', 'u')`, [patient],
    );
  }, 60_000);

  const IDS = ['FULL', 'PARTIAL', 'UNBOUND', 'STALE', 'SILENT', 'PUMP', 'BARE', 'PATIENT'];

  it('the batch gives every machine exactly the coverage the per-machine path gives it', async () => {
    const refs = IDS.map((externalId) => ({ sourceSystem: SRC, externalId }));
    const batched = await bindings.coverageMany(acme, refs, NOW);
    for (const ref of refs) {
      expect({ machine: ref.externalId, coverage: batched.get(`${SRC}/${ref.externalId}`) })
        .toEqual({ machine: ref.externalId, coverage: await bindings.coverage(acme, ref, NOW) });
    }
    // And the cases are really different from each other — the comparison is not vacuous.
    const missing = (id: string) => batched.get(`${SRC}/${id}`)!.missing.map((x) => x.reason);
    expect(missing('PARTIAL')).toEqual(['mapping_required']);
    expect(missing('UNBOUND')).toEqual(['unbound']);
    expect(batched.get(`${SRC}/PATIENT`)!.covered[0].staleAfterSeconds).toBe(14400);
    expect(batched.get(`${SRC}/STALE`)!.covered[0].staleAfterSeconds).toBe(900);
  });

  it('machine_list on the page shows every machine\'s worst readiness, the same as before batching', async () => {
    const page = await pages.sitePage(acme, plantId, NOW);
    const rows = page.widgets.find((w) => w.widgetType === 'machine_list')!.data as { externalId: string; readiness: string }[];
    expect(Object.fromEntries(rows.map((r) => [r.externalId, r.readiness]))).toEqual({
      FULL: 'ready', PARTIAL: 'not_configured', UNBOUND: 'not_configured', STALE: 'not_available',
      SILENT: 'not_available', PUMP: 'ready', BARE: 'not_configured', PATIENT: 'ready',
    });
  });

  it('the page no longer costs six queries a machine: about one, plus a fixed few', async () => {
    let queries = 0;
    const original = PostgresQueryRunner.prototype.query;
    const spy = jest.spyOn(PostgresQueryRunner.prototype, 'query').mockImplementation(function (this: PostgresQueryRunner, ...args: any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
      queries += 1;
      return (original as any).apply(this, args); // eslint-disable-line @typescript-eslint/no-explicit-any
    });
    try {
      await pages.sitePage(acme, plantId, NOW);
    } finally {
      spy.mockRestore();
    }
    // Eight machines: 6 × 8 = 48 before; one latest-reading probe each, plus a fixed set, now.
    expect(queries).toBeLessThan(2 * IDS.length + 20);
  });
});
