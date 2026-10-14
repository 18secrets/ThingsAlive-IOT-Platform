import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { FleetOnboardingService } from '../src/inventory/services/fleet-onboarding.service';
import { SignalBindingService } from '../src/signal-binding/services/signal-binding.service';
import { createAppDataSource, createTestDataSource, describeDb } from './db';

/**
 * Bulk-registering a 1.0 fleet (task QONBOARD1). A migrated customer's machines and
 * loggers are in the mirror and nowhere in 2.0's register, so discovery finds nothing
 * to bind. This fills the register from the projections — adding only, reporting every
 * conflict rather than resolving it, and doing nothing the second time.
 */
describeDb('fleet onboarding: a 1.0 fleet into 2.0\'s register', () => {
  let owner: DataSource;
  let ds: DataSource;
  let onboarding: FleetOnboardingService;
  let bindings: SignalBindingService;

  const staff: RequestScope = { tenantId: '', userId: 'staff-1', roles: ['master-admin'], isPlatformRole: true };
  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const SRC = 'iot-platform-1';

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    onboarding = new FleetOnboardingService(ds);
    bindings = new SignalBindingService(ds);
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  /**
   * M1 is new to 2.0; M2 is registered already.
   *  D1 on M1: unknown to inventory          → register, assign, claim
   *  D2 on M2: this account's, unclaimed      → claim
   *  D3 on M2: already claimed to M2          → nothing
   *  D4 on M1: assigned to another account    → conflict
   *  D5 on M1: retired                        → conflict
   *  D6 on M1: claimed to M2 in 2.0           → conflict
   *  D7 on GHOST: a machine nobody lists      → conflict
   */
  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "device_inventory_event", "device_inventory", "sensor_map_projection", "device_projection",
        "equipment_projection", "equipment_profile" CASCADE`,
    );
    for (const id of ['M1', 'M2']) {
      await owner.query(
        `INSERT INTO equipment_projection (tenant_id, source_system, external_id, checksum, payload, synced_at, status, name)
           VALUES ('acme', $1, $2, 'c', '{}'::jsonb, now(), 'live', $3)`, [SRC, id, `Machine ${id}`],
      );
    }
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, tier, readiness, updated_by)
         VALUES ('acme', $1, 'M2', 'standard', '{}'::jsonb, 'u')`, [SRC],
    );
    for (const [imei, machine] of [['D1', 'M1'], ['D2', 'M2'], ['D3', 'M2'], ['D4', 'M1'], ['D5', 'M1'], ['D6', 'M1'], ['D7', 'GHOST']]) {
      await owner.query(
        `INSERT INTO device_projection (tenant_id, source_system, external_id, checksum, imei, equipment_external_id, payload, synced_at, status)
           VALUES ('acme', $1, $2, 'c', $3, $4, '{}'::jsonb, now(), 'live')`, [SRC, `dev-${imei}`, imei, machine],
      );
    }
    const inv = (imei: string, tenant: string | null, state: string, machine: string | null) => owner.query(
      `INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id, claimed_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)`, [imei, tenant, state, machine],
    );
    await inv('D2', 'acme', 'assigned', null);
    await inv('D3', 'acme', 'assigned', 'M2');
    await inv('D4', 'globex', 'assigned', null);
    await inv('D5', null, 'retired', null);
    await inv('D6', 'acme', 'assigned', 'M2');
    await owner.query(
      `INSERT INTO sensor_map_projection (tenant_id, source_system, external_id, checksum, imei, signal, sensor_name, unit, payload, synced_at, status)
         VALUES ('acme', $1, 'D1-coolant', 'c', 'D1', 'coolant_temp', 'Coolant', 'degC', '{}'::jsonb, now(), 'live')`, [SRC],
    );
  });

  const count = async (table: string) => (await owner.query(`SELECT count(*)::int AS n FROM "${table}"`))[0].n;

  it('plans without writing: what it would add, and every conflict by reason', async () => {
    const before = [await count('equipment_profile'), await count('device_inventory'), await count('device_inventory_event')];
    const plan = await onboarding.plan(staff, 'acme');
    expect(plan.createMachines).toEqual([{ sourceSystem: SRC, externalId: 'M1', name: 'Machine M1' }]);
    expect(plan.registerDevices.map((d) => d.imei)).toEqual(['D1']);
    expect(plan.claimDevices.map((d) => [d.imei, d.equipmentExternalId])).toEqual([['D2', 'M2']]);
    expect(plan.alreadyOnboarded).toBe(1);
    expect(plan.conflicts.map((c) => [c.imei, c.reason]).sort()).toEqual([
      ['D4', 'held_by_another_account'], ['D5', 'retired'], ['D6', 'claimed_to_another_machine'],
      ['D7', 'machine_not_in_projection'],
    ]);
    expect([await count('equipment_profile'), await count('device_inventory'), await count('device_inventory_event')])
      .toEqual(before);
  });

  it('applies: the machine mirrored, the logger registered, assigned and claimed, with its history', async () => {
    await onboarding.apply(staff, 'acme');
    expect(await owner.query(
      `SELECT external_id, origin, name FROM equipment_profile WHERE external_id = 'M1'`,
    )).toEqual([{ external_id: 'M1', origin: 'mirrored', name: 'Machine M1' }]);
    expect(await owner.query(
      `SELECT imei, tenant_id, state, equipment_external_id FROM device_inventory WHERE imei IN ('D1', 'D2') ORDER BY imei`,
    )).toEqual([
      { imei: 'D1', tenant_id: 'acme', state: 'assigned', equipment_external_id: 'M1' },
      { imei: 'D2', tenant_id: 'acme', state: 'assigned', equipment_external_id: 'M2' },
    ]);
    expect((await owner.query(`SELECT action FROM device_inventory_event WHERE imei = 'D1' ORDER BY at, action`))
      .map((r: { action: string }) => r.action).sort()).toEqual(['assign', 'claim', 'register']);
  });

  it('never resolves a conflict: the other account\'s device, the retired one and the claim elsewhere are untouched', async () => {
    await onboarding.apply(staff, 'acme');
    expect(await owner.query(
      `SELECT imei, tenant_id, state, equipment_external_id FROM device_inventory WHERE imei IN ('D4', 'D5', 'D6') ORDER BY imei`,
    )).toEqual([
      { imei: 'D4', tenant_id: 'globex', state: 'assigned', equipment_external_id: null },
      { imei: 'D5', tenant_id: null, state: 'retired', equipment_external_id: null },
      { imei: 'D6', tenant_id: 'acme', state: 'assigned', equipment_external_id: 'M2' },
    ]);
    expect(await owner.query(`SELECT count(*)::int AS n FROM device_inventory WHERE imei = 'D7'`)).toEqual([{ n: 0 }]);
  });

  it('is idempotent: a second apply has nothing left to do', async () => {
    await onboarding.apply(staff, 'acme');
    const events = await count('device_inventory_event');
    const again = await onboarding.apply(staff, 'acme');
    expect([again.createMachines, again.registerDevices, again.claimDevices]).toEqual([[], [], []]);
    expect(again.alreadyOnboarded).toBe(3);
    expect(await count('device_inventory_event')).toBe(events);
  });

  it('two applies at once both settle, and everything is written once', async () => {
    const results = await Promise.allSettled([onboarding.apply(staff, 'acme'), onboarding.apply(staff, 'acme')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await owner.query(`SELECT count(*)::int AS n FROM equipment_profile WHERE external_id = 'M1'`)).toEqual([{ n: 1 }]);
    expect(await owner.query(`SELECT count(*)::int AS n FROM device_inventory_event WHERE imei = 'D1'`)).toEqual([{ n: 3 }]);
  });

  it('afterwards discovery can see the logger: the reason this exists', async () => {
    await expect(bindings.discover(acme, { sourceSystem: SRC, externalId: 'M1' })).rejects.toThrow();
    await onboarding.apply(staff, 'acme');
    const found = await bindings.discover(acme, { sourceSystem: SRC, externalId: 'M1' });
    expect(found.mappedNotExpected.map((c) => [c.signalKey, c.imei])).toEqual([['coolant_temp', 'D1']]);
  });

  it('is platform staff only, both the plan and the apply', async () => {
    await expect(onboarding.plan(acme, 'acme')).rejects.toThrow(/Only Things Alive/);
    await expect(onboarding.apply(acme, 'acme')).rejects.toThrow(/Only Things Alive/);
    expect(await count('device_inventory_event')).toBe(0);
  });
});
