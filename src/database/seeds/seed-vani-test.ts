import 'reflect-metadata';

import { DataSource } from 'typeorm';
import { AlertService } from '../../alert/services/alert.service';
import { RequestScope } from '../../auth/types/request-scope';
import { ClientCatalogEntitlement } from '../../catalog/entities/client-catalog-entitlement.entity';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { EntitlementService } from '../../catalog/services/entitlement.service';
import { CopyOnGrantService } from '../../client-catalog/services/copy-on-grant.service';
import { Severity } from '../../common/severity';
import { PasswordService } from '../../identity/services/password.service';
import { runTenantSpanning } from '../../scope/tenant-session';
import { ProvisioningService } from '../../tenancy/services/provisioning.service';
import { dataSourceOptions } from '../data-source';

/**
 * The USA test client for the Vani voice integration (integration guide §3–§5, plan
 * Phase 4): one tenant, one diesel generator from the library, linked to the account
 * Vani operations already registered, and an alert that asks Vani to phone about it.
 *
 *   SEED_VANI_TEST_ENABLED=true npm run seed:vani-test
 *
 * **Local databases only, for now.** The script refuses any database host but
 * localhost. Seeding a shared environment writes a customer-shaped tenant into it and
 * queues a call to a real phone (Deepak's), so it waits for a decision rather than a
 * flag somebody might leave set.
 *
 * **The machine comes from the library.** `diesel-generator` is granted and the machine
 * is that class, not a hand-built record. The library class has no bearing-temperature
 * signal, so the alert is on `vibration_velocity` — the closest library signal to the
 * guide's bearing story — with a critical, plain-spoken rule. The rule's name is the
 * sentence Vani reads as the alert title.
 *
 * Through the platform's own services where one exists (provisioning, grant and
 * copy-on-grant, the alert rule, alert evaluation — which is also what queues the Vani
 * call); direct rows where the platform has no write path of its own (equipment,
 * device, bindings, telemetry, the Vani links). Running it twice is safe: it reports the
 * client is already there and changes nothing.
 *
 * There is no reset. Provisioning creates rows the database deliberately refuses to
 * delete outside the demo seeder (D-005). Locally, start again from a fresh database.
 */

export const VANI_TEST_TENANT = 'usa-test-client';
export const VANI_TEST_SOURCE = 'seed-vani-test';
export const VANI_TEST_MACHINE = 'DG-01';
export const VANI_ACCOUNT_ID = 'usa-test-01';
export const VANI_MACHINE_ID = 'dg-01';
export const LIBRARY_CLASS = 'diesel-generator';
export const RULE_SLUG = 'main-bearing-vibration';
/** Logger on DG-01. The 3599 prefix is not issued to any device in the pool. */
export const VANI_TEST_IMEI = '359900000000101';

const SEEDER = 'seed-vani-test';
const STEP_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
/** The guide's trend window: 72 hours. */
const HISTORY_MS = 72 * HOUR_MS;
/**
 * ISO 10816-3 Group 2, the library scenario's own "unacceptable above" (zone C/D). The
 * last day of the trend sits past it, so the rule's 6-of-10 holds whenever it is run.
 */
export const VIBRATION_LIMIT_MM_S = 4.5;

const PLATFORM: RequestScope = { tenantId: '', userId: SEEDER, roles: ['master-admin'], isPlatformRole: true };

export interface SeedVaniTestResult {
  created: boolean;
  tenantId: string;
  alertsRaised: number;
  callsQueued: number;
  invitationToken: string | null;
}

export function requireEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.SEED_VANI_TEST_ENABLED !== 'true') {
    throw new Error(
      'Refused: seed:vani-test writes a tenant and queues a phone call. Pass SEED_VANI_TEST_ENABLED=true '
      + 'for this one command (never as a standing variable on a deployed service).',
    );
  }
}

/** Local only until somebody decides otherwise. Read from the same settings the connection uses. */
export function requireLocal(env: NodeJS.ProcessEnv = process.env): void {
  const host = env.DATABASE_URL ? new URL(env.DATABASE_URL).hostname : (env.DB_HOST ?? 'localhost');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`Refused: seed:vani-test runs against a local database only, and this one is "${host}".`);
  }
}

/** The machine's last 72 hours: a generator running steadily while its bearing vibration climbs. */
export function vaniTestReadings(now: Date): { signal: string; unit: string; times: Date[]; values: number[] }[] {
  const end = Math.floor(now.getTime() / STEP_MS) * STEP_MS;
  const times: Date[] = [];
  for (let t = end - HISTORY_MS; t <= end; t += STEP_MS) times.push(new Date(t));
  // Deterministic wobble, so a reseed draws the same story and a test can assert on it.
  const wobble = (i: number, scale: number) => Math.sin(i * 1.7) * scale;
  const progress = (i: number) => i / (times.length - 1);
  return [
    // Rated speed for a 50 Hz four-pole set; a generator holds it whatever the load.
    { signal: 'engine_rpm', unit: 'rpm', times, values: times.map((_, i) => 1500 + wobble(i, 4)) },
    // The guide's "running at about 62 percent load".
    { signal: 'engine_load', unit: 'percent', times, values: times.map((_, i) => 62 + wobble(i, 2.5)) },
    // 2.4 mm/s (zone B, fine) climbing to 5.2 mm/s (past the zone C/D limit) over 72 hours.
    {
      signal: 'vibration_velocity', unit: 'mm/s', times,
      values: times.map((_, i) => Math.round((2.4 + 2.8 * progress(i) + wobble(i, 0.08)) * 100) / 100),
    },
  ];
}

const services = (ds: DataSource) => ({
  entitlements: new EntitlementService(
    ds.getRepository(ClientCatalogEntitlement), ds.getRepository(EquipmentClassProfile), new CopyOnGrantService(ds),
  ),
  provisioning: new ProvisioningService(ds, new PasswordService()),
  alerts: new AlertService(ds),
});

export async function seedVaniTest(
  ds: DataSource,
  opts: { now?: Date; env?: NodeJS.ProcessEnv } = {},
): Promise<SeedVaniTestResult> {
  const env = opts.env ?? process.env;
  requireEnabled(env);
  requireLocal(env);
  const now = opts.now ?? new Date();

  const [present] = await ds.query(`SELECT 1 FROM tenant WHERE tenant_id = $1`, [VANI_TEST_TENANT]);
  if (present) {
    return { created: false, tenantId: VANI_TEST_TENANT, alertsRaised: 0, callsQueued: 0, invitationToken: null };
  }

  const [libraryClass]: { version: number }[] = await ds.query(
    `SELECT version FROM equipment_class_profile WHERE slug = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`,
    [LIBRARY_CLASS],
  );
  if (!libraryClass) {
    throw new Error(
      `The library class "${LIBRARY_CLASS}" is not published here, so it cannot be granted. On a local test `
      + 'database: npx ts-node src/database/seeds/seed-catalog.ts --publish, then run this again.',
    );
  }

  const s = services(ds);
  const provisioned = await s.provisioning.provision(PLATFORM, {
    tenantId: VANI_TEST_TENANT, name: 'USA Test Client', plan: 'test', region: 'US',
    superAdmin: {
      email: (env.SEED_VANI_ADMIN_EMAIL ?? 'usa-test-admin@usa-test-client.example').toLowerCase(),
      fullName: 'Deepak Panguluri',
      phone: '+12012031340',
    },
  }, now);
  await s.entitlements.grant(PLATFORM, VANI_TEST_TENANT, LIBRARY_CLASS, 'Vani integration test client (seed:vani-test).');

  const readings = vaniTestReadings(now);
  const commissionedAt = new Date(now.getTime() - 30 * 24 * HOUR_MS);

  await runTenantSpanning(ds, 'seed:vani-test machine', async (m) => {
    const [plant] = await m.query(
      `INSERT INTO plant (tenant_id, code, name, address, description, created_by, updated_by)
         VALUES ($1, 'GRAPEVINE-TX', 'Grapevine, TX', 'Grapevine, Texas, USA',
                 'Vani integration test site (seed:vani-test).', $2, $2)
       RETURNING id`,
      [VANI_TEST_TENANT, SEEDER],
    );
    await m.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, equipment_class_slug, class_version,
                                      origin, status, tier, readiness, commissioned_at, plant_id, updated_by)
         VALUES ($1, $2, $3, 'Diesel Generator DG-01', $4, $5, 'client', 'active', 'basic', '{}'::jsonb, $6, $7, $8)`,
      [VANI_TEST_TENANT, VANI_TEST_SOURCE, VANI_TEST_MACHINE, LIBRARY_CLASS, libraryClass.version, commissionedAt, plant.id, SEEDER],
    );
    await m.query(
      `INSERT INTO device_inventory (imei, tenant_id, state, model, batch_ref, assigned_at, assigned_by,
                                     equipment_external_id, claimed_at, claimed_by)
         VALUES ($1, $2, 'assigned', 'TA-OBD-CAN', $3, $4, $3, $5, $4, $3)`,
      [VANI_TEST_IMEI, VANI_TEST_TENANT, SEEDER, commissionedAt, VANI_TEST_MACHINE],
    );
    for (const r of readings) {
      await m.query(
        `INSERT INTO signal_binding_version (tenant_id, source_system, external_id, signal_key, measurement_role,
                                             component_id, origin, imei, channel, canonical_unit, valid_from,
                                             is_primary, status, discovered_by, approved_by, approved_at)
           VALUES ($1, $2, $3, $4, $4, '', 'physical', $5, $4, $6, $7, true, 'active', 'manual', $8, $7)`,
        [VANI_TEST_TENANT, VANI_TEST_SOURCE, VANI_TEST_MACHINE, r.signal, VANI_TEST_IMEI, r.unit, commissionedAt, SEEDER],
      );
    }

    // Vani's side is registered already (guide §3.1); this records which account and
    // machine that registration is. Before the alert, so the alert can queue its call.
    await m.query(
      `INSERT INTO vani_account_link (tenant_id, vani_account_id, customer_phone, callback_url)
         VALUES ($1, $2, '+12012031340', $3)`,
      [VANI_TEST_TENANT, VANI_ACCOUNT_ID, env.SEED_VANI_CALLBACK_URL?.trim() || null],
    );
    await m.query(
      `INSERT INTO vani_machine_link (tenant_id, source_system, external_id, machine_id, spoken_name)
         VALUES ($1, $2, $3, $4, 'Diesel Generator DG-01')`,
      [VANI_TEST_TENANT, VANI_TEST_SOURCE, VANI_TEST_MACHINE, VANI_MACHINE_ID],
    );
  });

  for (const month of new Set(readings[0].times.map((t) => t.toISOString().slice(0, 7)))) {
    await ds.query(`SELECT ensure_telemetry_partition($1::date)`, [`${month}-01`]);
  }
  for (const r of readings) {
    await runTenantSpanning(ds, 'seed:vani-test telemetry', (m) => m.query(
      `INSERT INTO telemetry_reading (tenant_id, imei, signal, value, unit, source_timestamp, received_at, source)
         SELECT $1, $2, $3, v, $4, ts, ts, 'simulated'
           FROM unnest($5::timestamptz[], $6::double precision[]) AS r(ts, v)`,
      [VANI_TEST_TENANT, VANI_TEST_IMEI, r.signal, r.unit, r.times.map((t) => t.toISOString()), r.values],
    ));
  }

  const tenantAdmin: RequestScope = { tenantId: VANI_TEST_TENANT, userId: SEEDER, roles: ['super admin'], isPlatformRole: false };
  await s.alerts.createRule(tenantAdmin, {
    slug: RULE_SLUG,
    // Read aloud by Vani as the alert's title, so it is a sentence, not a code.
    name: 'Main bearing vibration on Diesel Generator DG-01 is rising. Schedule an inspection within the week',
    description: 'Vani test alert (seed:vani-test). Fires when bearing vibration passes the ISO 10816-3 zone C/D limit.',
    trigger: 'signal-threshold',
    params: { signal: 'vibration_velocity', max: VIBRATION_LIMIT_MM_S },
    appliesTo: 'equipment',
    sourceSystem: VANI_TEST_SOURCE,
    externalId: VANI_TEST_MACHINE,
    severity: Severity.Critical,
  });

  // The last ten readings of every signal, judged by the engine itself — which is also
  // what writes the Vani call request, in the same transaction as the alert.
  const windowStart = readings[0].times[readings[0].times.length - 10];
  const windowEnd = new Date(readings[0].times[readings[0].times.length - 1].getTime() + STEP_MS);
  const fired = await s.alerts.evaluateWindow({
    tenantId: VANI_TEST_TENANT, sourceSystem: VANI_TEST_SOURCE, externalId: VANI_TEST_MACHINE,
    // A generator runs round the clock and has no shift; the date is the window's own,
    // in the customer's timezone, which is how the account would name the day.
    shiftLocalDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(windowStart),
    windowStart, windowEnd,
    readings: readings.flatMap((r) => r.times.slice(-10).map((t, i) => ({
      imei: VANI_TEST_IMEI, signal: r.signal, value: r.values[r.values.length - 10 + i], unit: r.unit,
      sourceTimestamp: t.toISOString(),
    }))),
    predictions: [], chains: [],
  });

  const [{ calls }] = await runTenantSpanning(ds, 'seed:vani-test count', (m) => m.query(
    `SELECT count(*)::int AS calls FROM vani_call WHERE tenant_id = $1`, [VANI_TEST_TENANT]));
  return {
    created: true, tenantId: VANI_TEST_TENANT, alertsRaised: fired.length, callsQueued: calls,
    invitationToken: provisioned.invitationToken,
  };
}

async function main() {
  requireEnabled();
  requireLocal();
  const ds = new DataSource(dataSourceOptions(process.env as any, { appRole: null }));
  await ds.initialize();
  try {
    const result = await seedVaniTest(ds);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result.created ? result : { ...result, note: 'Already present; nothing changed.' }, null, 2));
  } finally {
    await ds.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  });
}
