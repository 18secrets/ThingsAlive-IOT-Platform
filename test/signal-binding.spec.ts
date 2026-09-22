import { DataSource } from 'typeorm';
import { createTestDataSource, describeDb } from './db';

/**
 * The signal binding layer's schema guarantees (task Q08S).
 *
 * These are the rules that must hold in the database rather than in a service, because
 * a service check loses to a concurrent insert and because the next person to write a
 * repository method will not know they existed. Every one of them is asserted by
 * attempting the thing it forbids and expecting the database to refuse.
 *
 * The suite runs the whole migration chain against a real Postgres. An exclusion
 * constraint, a partial unique index and a generated range column are all Postgres
 * behaviour; proving them against an in-memory substitute would prove nothing.
 */
describeDb('signal bindings', () => {
  let ds: DataSource;

  const TENANT_A = 'acme';
  const TENANT_B = 'globex';
  const SRC = 'ta-2.0';

  beforeAll(async () => {
    ds = await createTestDataSource();
    await ds.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await ds.runMigrations({ transaction: 'all' });

    for (const t of [TENANT_A, TENANT_B]) {
      await ds.query(
        `INSERT INTO tenant (tenant_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [t, t],
      );
      // Both accounts call their generator the same thing, on purpose.
      await ds.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, equipment_class_slug)
         VALUES ($1, $2, 'DG-3305', 'diesel-generator')`,
        [t, SRC],
      );
    }
    // A composite machine with two temperature probes — the case a single binding
    // per signal cannot express.
    await ds.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, equipment_class_slug)
       VALUES ($1, $2, 'CP-9', 'concrete-pump')`,
      [TENANT_A, SRC],
    );
  });

  afterAll(async () => { await ds?.destroy(); });

  const bind = (over: Record<string, unknown> = {}) => {
    const row = {
      tenant_id: TENANT_A, source_system: SRC, external_id: 'DG-3305',
      signal_key: 'coolant_temp_c', measurement_role: 'coolant_temp_c',
      component_id: '', origin: 'physical', imei: '860000000000001',
      canonical_unit: 'degC', valid_from: '2026-01-01T00:00:00Z', valid_to: null,
      is_primary: true, status: 'active', discovered_by: 'manual',
      ...over,
    } as Record<string, unknown>;
    const cols = Object.keys(row);
    const params = cols.map((_, i) => `$${i + 1}`);
    return ds.query(
      `INSERT INTO signal_binding_version (${cols.join(',')}) VALUES (${params.join(',')}) RETURNING id`,
      Object.values(row),
    );
  };

  describe('one primary per role, decided rather than averaged', () => {
    it('refuses a second active primary whose validity overlaps', async () => {
      await bind({ external_id: 'DG-3305', imei: '860000000000001' });
      // A second candidate sensor for the same role, same machine, same window.
      // Silently averaging two probes is how a fault on one gets hidden by the other.
      await expect(bind({ imei: '860000000000002' })).rejects.toThrow(/ex_signal_binding_primary/);
    });

    it('allows the replacement once the first one is closed off', async () => {
      // A sensor swapped in March: the old binding ends, the new one starts. Adjacent,
      // not overlapping, because the validity range is half-open.
      await ds.query(
        `UPDATE signal_binding_version SET valid_to = '2026-03-01T00:00:00Z'
          WHERE tenant_id = $1 AND external_id = 'DG-3305' AND imei = '860000000000001'`,
        [TENANT_A],
      );
      await expect(
        bind({ imei: '860000000000003', valid_from: '2026-03-01T00:00:00Z' }),
      ).resolves.toBeDefined();
    });

    it('allows two probes on one machine when they are different components', async () => {
      // The composite case. Same signal, same machine, two real sensors in two places —
      // legitimate, and distinguished by component rather than by luck.
      await bind({ external_id: 'CP-9', component_id: 'hopper', imei: '860000000000010' });
      await expect(
        bind({ external_id: 'CP-9', component_id: 'hydraulic-tank', imei: '860000000000011' }),
      ).resolves.toBeDefined();
    });

    it('does not constrain proposals, only what is active', async () => {
      // Several candidates may sit unreviewed at once. Choosing between them is the
      // review; refusing them up front would make discovery unable to report options.
      await bind({ external_id: 'CP-9', component_id: 'boom', imei: '86000000000020', status: 'discovered_unreviewed', is_primary: false });
      await expect(
        bind({ external_id: 'CP-9', component_id: 'boom', imei: '86000000000021', status: 'discovered_unreviewed', is_primary: false }),
      ).resolves.toBeDefined();
    });
  });

  describe('a binding has to say where it comes from', () => {
    it('refuses a physical binding with no source device', async () => {
      await expect(
        bind({ external_id: 'CP-9', component_id: 'x1', imei: null }),
      ).rejects.toThrow(/ck_signal_binding_source/);
    });

    it('accepts a virtual measure with no device, because it has none', async () => {
      await expect(
        bind({ external_id: 'CP-9', component_id: 'x2', origin: 'virtual', imei: null }),
      ).resolves.toBeDefined();
    });

    it('refuses an unknown provenance', async () => {
      // discovered_by is what auto-approval keys off. An unrecognised value would be
      // treated as "not a model" by any policy that checks with a NOT IN.
      await expect(
        bind({ external_id: 'CP-9', component_id: 'x3', discovered_by: 'vibes' }),
      ).rejects.toThrow(/ck_signal_binding_discovered_by/);
    });

    it('refuses a validity window that ends before it starts', async () => {
      // Refused — but by the range constructor in the generated column, which runs
      // before ck_signal_binding_validity is ever evaluated. So the database says
      // "range lower bound must be less than or equal to range upper bound", naming
      // no table, no column and no constraint.
      //
      // That is safe and unhelpful in equal measure. The CHECK stays because it states
      // the intent and would catch the case if the generated expression ever changed,
      // but the usable message has to come from the service validating before it
      // inserts. Asserted here as behaviour rather than as a constraint name, so this
      // test does not quietly start passing for the wrong reason.
      await expect(
        bind({ external_id: 'CP-9', component_id: 'x4', valid_to: '2025-01-01T00:00:00Z' }),
      ).rejects.toThrow(/range lower bound|ck_signal_binding_validity/);
    });
  });

  describe('calibration', () => {
    it('refuses identity calibration with no recorded basis', async () => {
      // "Raw equals canonical" is a claim about an instrument, not a default. Without a
      // basis it is indistinguishable from nobody having filled the form in.
      await expect(
        ds.query(`INSERT INTO calibration_version (tenant_id, method) VALUES ($1, 'identity')`, [TENANT_A]),
      ).rejects.toThrow(/ck_calibration_identity_basis/);
    });

    it('accepts identity when the basis is stated', async () => {
      await expect(
        ds.query(
          `INSERT INTO calibration_version (tenant_id, method, basis, approved_by)
           VALUES ($1, 'identity', 'ECU reports in canonical units; factory calibrated', 'deepak')`,
          [TENANT_A],
        ),
      ).resolves.toBeDefined();
    });

    it('refuses a method nobody implements', async () => {
      await expect(
        ds.query(`INSERT INTO calibration_version (tenant_id, method) VALUES ($1, 'vibes')`, [TENANT_A]),
      ).rejects.toThrow(/ck_calibration_method/);
    });
  });

  describe('approved scalar parameters', () => {
    const param = (over: Record<string, unknown> = {}) => {
      const row = {
        tenant_id: TENANT_A, source_system: SRC, external_id: 'DG-3305',
        parameter_key: 'fuel_tank_capacity_liters', value: 990, unit: 'L',
        source: 'equipment-template', status: 'proposed', version: 1, ...over,
      } as Record<string, unknown>;
      const cols = Object.keys(row);
      return ds.query(
        `INSERT INTO equipment_parameter (${cols.join(',')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
        Object.values(row),
      );
    };

    it('allows several proposals for the same parameter', async () => {
      await param({ version: 1 });
      await expect(param({ version: 2, value: 1000, source: 'manual' })).resolves.toBeDefined();
    });

    it('allows exactly one approved value', async () => {
      await param({ version: 3, status: 'approved', approved_by: 'deepak' });
      // Two approved capacities would mean the runtime's answer depends on which row it read.
      await expect(
        param({ version: 4, value: 1200, status: 'approved', approved_by: 'deepak' }),
      ).rejects.toThrow(/uq_equipment_parameter_approved/);
    });

    it('refuses a source it cannot trace', async () => {
      await expect(param({ version: 5, source: 'somewhere' })).rejects.toThrow(
        /ck_equipment_parameter_source/,
      );
    });
  });

  describe('tenant isolation', () => {
    it('refuses a binding pointing at another account\'s machine', async () => {
      // Both accounts have a DG-3305. The composite key includes the tenant, so this
      // resolves to a machine that does not exist rather than to somebody else's.
      await expect(
        bind({ tenant_id: TENANT_B, external_id: 'CP-9', component_id: 'z' }),
      ).rejects.toThrow(/fk_signal_binding_equipment/);
    });

    it('is covered by the isolation policy, forced', async () => {
      const rows = await ds.query(
        `SELECT c.relname FROM pg_class c
          JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'tenant_isolation'
         WHERE c.relname = ANY($1) AND c.relrowsecurity AND c.relforcerowsecurity`,
        [['signal_binding_version', 'calibration_version', 'sensor_instance', 'equipment_parameter']],
      );
      expect(rows.map((r: any) => r.relname).sort()).toEqual([
        'calibration_version', 'equipment_parameter', 'sensor_instance', 'signal_binding_version',
      ]);
    });
  });

  describe('the migration', () => {
    it('has a down path that leaves nothing behind', async () => {
      const [{ count: before }] = await ds.query(
        `SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [['signal_binding_version', 'calibration_version', 'sensor_instance', 'equipment_parameter']],
      );
      expect(before).toBe(4);

      await ds.undoLastMigration({ transaction: 'all' });

      const [{ count: after }] = await ds.query(
        `SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [['signal_binding_version', 'calibration_version', 'sensor_instance', 'equipment_parameter']],
      );
      expect(after).toBe(0);

      await ds.runMigrations({ transaction: 'all' });
    });
  });
});
