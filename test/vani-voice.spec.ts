import { DataSource, EntityManager } from 'typeorm';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

/**
 * The schema under the Vani voice integration (`1763600000000-VaniVoice.ts`).
 *
 * Each rule here stops a phone call going to the wrong person, about the wrong
 * machine, or twice. They live in the database because the code that requests a call
 * runs from an outbox worker and from an inbound callback at the same time, and a
 * service check loses to whichever of the two commits second. Every one is asserted
 * by attempting the forbidden thing and expecting a refusal.
 *
 * Owner fixtures, `ta_app` for everything about grants and row-level security: a
 * superuser bypasses both, so a refusal seen through the owner proves nothing about
 * what the running service is allowed to do.
 */
describeDb('vani voice: links, calls and outcomes', () => {
  let owner: DataSource;
  let app: DataSource;

  const SRC = 'ta-2.0';
  let alertA: string;
  let alertA2: string;
  let alertB: string;

  /** A transaction as the service runs it: ta_app, inside one tenant. */
  const asTenant = <R>(tenant: string, fn: (m: EntityManager) => Promise<R>) =>
    app.transaction(async (m) => {
      await m.query(`SELECT set_config('ta.tenant_id', $1, true)`, [tenant]);
      return fn(m);
    });

  const alert = async (tenant: string, ext: string): Promise<string> => {
    const [row] = await owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
         VALUES ($1, gen_random_uuid(), 'Bearing temperature rising', $2, $3, 'critical', 'Main bearing trending hot', '{}'::jsonb, 'open', now())
       RETURNING id`,
      [tenant, SRC, ext],
    );
    return row.id;
  };

  const call = (over: Record<string, unknown> = {}) => {
    const row = {
      tenant_id: 'usa-test', alert_event_id: alertA, vani_account_id: 'usa-test-01',
      machine_id: 'dg-01', severity: 'critical', request: JSON.stringify({ event_id: alertA }),
      ...over,
    } as Record<string, unknown>;
    const cols = Object.keys(row);
    return owner.query(
      `INSERT INTO vani_call (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      Object.values(row),
    );
  };

  const outcome = (over: Record<string, unknown> = {}) => {
    const row = {
      tenant_id: 'usa-test', alert_event_id: alertA, attempt: 1, call_id: 'f89d1ee47b1c',
      outcome: 'completed_spoke_with_customer', payload: '{}', ...over,
    } as Record<string, unknown>;
    const cols = Object.keys(row);
    return owner.query(
      `INSERT INTO vani_call_outcome (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row),
    );
  };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    app = await createAppDataSource();

    for (const t of ['usa-test', 'globex']) {
      await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ($1, $1)`, [t]);
      // Both accounts have a DG-01, so a link that ignored the tenant would match both.
      for (const ext of ['DG-01', 'DG-02']) {
        await owner.query(
          `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
             VALUES ($1, $2, $3, $3, 'client', 'active', 'basic', '{}'::jsonb)`,
          [t, SRC, ext],
        );
      }
    }
    await owner.query(
      `INSERT INTO vani_account_link (tenant_id, vani_account_id, customer_phone, callback_url)
         VALUES ('usa-test', 'usa-test-01', '+12012031340', 'https://api.example.test/api/v1/vani/outcome-callback')`,
    );
    await owner.query(
      `INSERT INTO vani_machine_link (tenant_id, source_system, external_id, machine_id, spoken_name)
         VALUES ('usa-test', $1, 'DG-01', 'dg-01', 'Diesel Generator DG-01')`,
      [SRC],
    );
    alertA = await alert('usa-test', 'DG-01');
    alertA2 = await alert('usa-test', 'DG-01');
    alertB = await alert('globex', 'DG-01');
  }, 60_000);

  afterAll(async () => { await app?.destroy(); await owner?.destroy(); });

  describe('an account link holds what Vani will accept', () => {
    it('refuses a phone number Vani would not accept', async () => {
      await expect(owner.query(
        `INSERT INTO vani_account_link (tenant_id, vani_account_id, customer_phone) VALUES ('globex', 'globex-01', '201-203-1340')`,
      )).rejects.toThrow(/ck_vani_customer_phone/);
    });

    it('refuses a callback address that is not https', async () => {
      await expect(owner.query(
        `INSERT INTO vani_account_link (tenant_id, vani_account_id, callback_url) VALUES ('globex', 'globex-01', 'http://api.example.test/cb')`,
      )).rejects.toThrow(/ck_vani_callback_url/);
    });
  });

  describe('a machine is linked once, inside a linked account', () => {
    const link = (over: Record<string, unknown> = {}) => {
      const row = {
        tenant_id: 'usa-test', source_system: SRC, external_id: 'DG-02',
        machine_id: 'dg-02', spoken_name: 'Diesel Generator DG-02', ...over,
      } as Record<string, unknown>;
      const cols = Object.keys(row);
      return owner.query(
        `INSERT INTO vani_machine_link (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        Object.values(row),
      );
    };

    it('refuses a machine in a tenant with no Vani account', async () => {
      await expect(link({ tenant_id: 'globex', external_id: 'DG-01', machine_id: 'dg-01' }))
        .rejects.toThrow(/fk_vani_machine_link_account/);
    });

    it('refuses a machine that is not ours', async () => {
      await expect(link({ external_id: 'NOT-A-MACHINE' })).rejects.toThrow(/fk_vani_machine_link_equipment/);
    });

    it('refuses two Vani ids for one machine', async () => {
      await expect(link({ external_id: 'DG-01', machine_id: 'dg-01b' })).rejects.toThrow(/uq_vani_machine_link_equipment/);
    });

    it('refuses one Vani id for two machines', async () => {
      // A call about DG-02 would then describe whichever machine was linked first.
      await expect(link({ machine_id: 'dg-01' })).rejects.toThrow(/uq_vani_machine_link_machine/);
    });

    it('refuses a blank spoken name, because Vani says it aloud', async () => {
      await expect(link({ spoken_name: '   ' })).rejects.toThrow(/ck_vani_spoken_name/);
    });
  });

  describe('one alert, one call', () => {
    it('refuses a second call request for the same alert', async () => {
      await call();
      // The alert id is Vani's idempotency key. A second row would be a second retry
      // loop resending the same event — harmless to Vani, but a history here saying
      // we asked twice.
      await expect(call()).rejects.toThrow(/uq_vani_call_alert/);
    });

    it('refuses a severity Vani does not have', async () => {
      await expect(call({ alert_event_id: alertA2, severity: 'high' })).rejects.toThrow(/ck_vani_call_severity/);
    });

    it('refuses an edit to what was asked, so a retry resends the same body', async () => {
      await expect(asTenant('usa-test', (m) => m.query(
        `UPDATE vani_call SET request = '{"event_id":"changed"}'::jsonb WHERE alert_event_id = $1`, [alertA],
      ))).rejects.toThrow(/cannot change, only its answer/);
    });

    it('settles a pending call once, and then it is final', async () => {
      await asTenant('usa-test', (m) => m.query(
        `UPDATE vani_call SET state = 'accepted', http_status = 202, call_id = 'f89d1ee47b1c', disposition = 'dialed'
           WHERE alert_event_id = $1`, [alertA],
      ));
      await expect(asTenant('usa-test', (m) => m.query(
        `UPDATE vani_call SET state = 'pending' WHERE alert_event_id = $1`, [alertA],
      ))).rejects.toThrow(/is final/);
    });

    it('does not let the service withdraw a call request', async () => {
      await expect(asTenant('usa-test', (m) => m.query(
        `DELETE FROM vani_call WHERE alert_event_id = $1`, [alertA],
      ))).rejects.toThrow(/permission denied/);
    });
  });

  describe('an outcome is recorded once per attempt, as received', () => {
    it('refuses the same attempt twice, which is what a repeated callback looks like', async () => {
      await outcome();
      await expect(outcome()).rejects.toThrow(/uq_vani_call_outcome_attempt/);
      await expect(outcome({ attempt: 2, outcome: 'voicemail_dropped' })).resolves.toBeDefined();
    });

    it('refuses an outcome Vani does not send', async () => {
      await expect(outcome({ attempt: 3, outcome: 'answered' })).rejects.toThrow(/ck_vani_call_outcome_outcome/);
    });

    it('refuses an outcome for an alert we never asked Vani about', async () => {
      await expect(outcome({ alert_event_id: alertA2 })).rejects.toThrow(/fk_vani_call_outcome_call/);
    });

    it('refuses an outcome filed under a tenant that did not ask for the call', async () => {
      await expect(outcome({ tenant_id: 'globex', attempt: 5 })).rejects.toThrow(/fk_vani_call_outcome_call/);
    });

    it('does not let the service rewrite what Vani reported', async () => {
      await expect(asTenant('usa-test', (m) => m.query(
        `UPDATE vani_call_outcome SET outcome = 'failed' WHERE alert_event_id = $1`, [alertA],
      ))).rejects.toThrow(/permission denied/);
    });
  });

  describe('each account sees only its own', () => {
    it('hides one tenant\'s links, calls and outcomes from another', async () => {
      const seen = await asTenant('globex', async (m) => ({
        accounts: (await m.query(`SELECT 1 FROM vani_account_link`)).length,
        machines: (await m.query(`SELECT 1 FROM vani_machine_link`)).length,
        calls: (await m.query(`SELECT 1 FROM vani_call`)).length,
        outcomes: (await m.query(`SELECT 1 FROM vani_call_outcome`)).length,
      }));
      expect(seen).toEqual({ accounts: 0, machines: 0, calls: 0, outcomes: 0 });
    });

    it('refuses a call request written into another tenant', async () => {
      await expect(asTenant('globex', (m) => m.query(
        `INSERT INTO vani_call (tenant_id, alert_event_id, vani_account_id, machine_id, severity, request)
           VALUES ('usa-test', $1, 'usa-test-01', 'dg-01', 'critical', '{}'::jsonb)`, [alertA2],
      ))).rejects.toThrow(/row-level security/);
    });

    it('lets a tenant record its own call', async () => {
      await expect(asTenant('globex', (m) => m.query(
        `INSERT INTO vani_call (tenant_id, alert_event_id, vani_account_id, machine_id, severity, request)
           VALUES ('globex', $1, 'globex-01', 'dg-01', 'warning', '{}'::jsonb)`, [alertB],
      ))).resolves.toBeDefined();
    });
  });

  it('goes back down cleanly, and up again', async () => {
    await undoMigrationNamed(owner, 'VaniVoice1763600000000');
    const left = await owner.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'vani_%'`,
    );
    expect(left).toEqual([]);
    await owner.runMigrations({ transaction: 'all' });
    const back = await owner.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'vani_%' ORDER BY 1`,
    );
    expect(back.map((r: { table_name: string }) => r.table_name))
      .toEqual(['vani_account_link', 'vani_call', 'vani_call_outcome', 'vani_machine_link']);
  }, 60_000);
});
