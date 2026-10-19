import { DataSource } from 'typeorm';
import {
  EXPIRED_ERROR, MAX_ATTEMPTS, OutboxConsumer, OutboxHandler,
} from '../src/events/outbox-consumer';
import { ScopeResolverService } from '../src/identity/services/scope-resolver.service';
import { escalationEmail, IncidentNotifyHandler } from '../src/incident/incident-notify.handler';
import { OutgoingMail } from '../src/mail/mail.service';
import { withTenantId } from '../src/scope/tenant-session';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

/** A mail transport that records what it was given, and can be told to refuse someone. */
class FakeMail {
  readonly sent: OutgoingMail[] = [];
  refuse = new Set<string>();
  publicUrl() { return 'https://console.example.test'; }
  async send(mail: OutgoingMail): Promise<boolean> {
    if (this.refuse.has(mail.to)) return false;
    this.sent.push(mail);
    return true;
  }
}

const MIN = 60_000;

/**
 * Escalation emails and the first outbox consumer (task QNOTIFY1, D20). The mail
 * transport is faked; everything that decides who is told — the users, their roles,
 * their sites, the resolver the API uses — is real, and so is the outbox they are read
 * from and the database rules that keep a message from going twice.
 */
describeDb('incident notifier: escalations, by email, once', () => {
  let owner: DataSource;
  let ds: DataSource;
  let mail: FakeMail;
  let consumer: OutboxConsumer;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  const NOW = new Date('2026-10-19T10:00:00Z');

  /**
   * acme: machine M1 at NORTH, M2 at SOUTH.
   *  owen   operator (no action.assign), owns the incidents            → told as owner
   *  ada    admin (tenant scope, action.assign)                        → an assigner
   *  sam    site manager (action.assign) for SOUTH only                 → not for M1
   *  nina   site manager (action.assign) for NORTH                      → an assigner for M1
   *  sue    admin, suspended; ivan admin, invited                       → never
   * globex: gina admin                                                  → never
   */
  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "notification_delivery", "domain_event", "incident_event", "incident",
      "user_plant_access", "app_user", "tenant_role", "equipment_profile", "plant" CASCADE`);
    const [north] = await owner.query(`INSERT INTO plant (tenant_id, code, name, status) VALUES ('acme','NORTH','North yard','active') RETURNING id`);
    const [south] = await owner.query(`INSERT INTO plant (tenant_id, code, name, status) VALUES ('acme','SOUTH','South yard','active') RETURNING id`);
    for (const [ext, plant] of [['M1', north.id], ['M2', south.id]]) {
      await owner.query(`INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness, plant_id)
        VALUES ('acme','ta-2.0',$1,$2,'client','active','basic','{}'::jsonb,$3)`, [ext, `Generator ${ext}`, plant]);
    }
    const role = (tenant: string, slug: string, caps: string[], shape: string) => owner.query(
      `INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape) VALUES ($1,$2,$2,$3::text[],$4)`,
      [tenant, slug, caps, shape]);
    await role('acme', 'operator', ['prediction.read'], 'tenant');
    await role('acme', 'admin', ['prediction.read', 'action.assign', 'action.work'], 'tenant');
    await role('acme', 'site-manager', ['prediction.read', 'action.assign'], 'plant');
    await role('globex', 'admin', ['prediction.read', 'action.assign'], 'tenant');
    const user = async (key: string, tenant: string, slug: string, status = 'active') => {
      const [u] = await owner.query(
        `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenant, `${key}@${tenant}.test`, key, slug, status]);
      ids[key] = u.id;
    };
    await user('owen', 'acme', 'operator');
    await user('ada', 'acme', 'admin');
    await user('sam', 'acme', 'site-manager');
    await user('nina', 'acme', 'site-manager');
    await user('sue', 'acme', 'admin', 'suspended');
    await user('ivan', 'acme', 'admin', 'invited');
    await user('gina', 'globex', 'admin');
    await owner.query(`INSERT INTO user_plant_access (tenant_id, user_id, plant_id) VALUES ('acme',$1,$2), ('acme',$3,$4)`,
      [ids.sam, south.id, ids.nina, north.id]);

    mail = new FakeMail();
    const handler = new IncidentNotifyHandler(mail as never, new ScopeResolverService(ds));
    consumer = new OutboxConsumer(ds, [handler]);
  });

  const incident = async (ext: string, opts: { owner?: string | null; status?: string; acknowledged?: boolean } = {}) => {
    const [row] = await owner.query(
      `INSERT INTO incident (tenant_id, source_system, external_id, severity, status, owner_user_id, opened_at, ack_due_at,
         resolve_due_at, acknowledged_at, resolved_at, resolution_note, escalation_level)
       VALUES ('acme','ta-2.0',$1,'high',$2,$3,$4,$5,$6,$7,$8,$9,1) RETURNING id`,
      // The table's own CHECKs: anything past open was acknowledged, and a resolved one
      // carries when and a note.
      [ext, opts.status ?? 'open', opts.owner === undefined ? ids.owen : opts.owner,
        new Date(NOW.getTime() - 120 * MIN), new Date(NOW.getTime() - 45 * MIN), new Date(NOW.getTime() - 10 * MIN),
        opts.acknowledged || (opts.status && opts.status !== 'open') ? new Date(NOW.getTime() - 30 * MIN) : null,
        opts.status === 'resolved' ? new Date(NOW.getTime() - 20 * MIN) : null,
        opts.status === 'resolved' ? 'Fuel line replaced' : null]);
    return row.id as string;
  };
  const escalated = async (incidentId: string, level: 1 | 2, ext = 'M1', at = new Date(NOW.getTime() - 5 * MIN)) => {
    const [row] = await owner.query(
      `INSERT INTO domain_event (event_type, tenant_id, subject, payload, occurred_at) VALUES ('incident.escalated.v1','acme',$1,$2::jsonb,$3) RETURNING id`,
      [incidentId, JSON.stringify({ incidentId, level, reason: level === 2 ? 'resolution_overdue' : 'acknowledgement_overdue',
        severity: 'high', machine: { sourceSystem: 'ta-2.0', externalId: ext }, ownerUserId: ids.owen }), at]);
    return row.id as string;
  };
  const eventRow = async (id: string) => (await owner.query(
    `SELECT delivery_state, attempts, last_error, next_attempt_at FROM domain_event WHERE id = $1`, [id]))[0];
  const timeline = async (incidentId: string) => owner.query(
    `SELECT kind, detail FROM incident_event WHERE incident_id = $1 ORDER BY at, kind`, [incidentId]);
  const to = () => mail.sent.map((s) => s.to).sort();

  it('level 1 with an owner: one email to the owner, recorded, the event delivered, the timeline says who', async () => {
    const inc = await incident('M1');
    const ev = await escalated(inc, 1);
    expect(await consumer.pass(NOW)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    expect(to()).toEqual(['owen@acme.test']);
    expect(mail.sent[0].subject).toBe('Escalated: high incident on Generator M1 not acknowledged in time');
    expect(mail.sent[0].text).toContain('Generator M1 at North yard');
    expect(mail.sent[0].text).toContain('45 minutes overdue');
    expect(mail.sent[0].text).toContain('https://console.example.test/incident-management');
    expect((await eventRow(ev)).delivery_state).toBe('delivered');
    expect(await owner.query(`SELECT recipient_user_id, channel FROM notification_delivery WHERE event_id = $1`, [ev]))
      .toEqual([{ recipient_user_id: ids.owen, channel: 'email' }]);
    expect(await timeline(inc)).toEqual([{ kind: 'notified', detail: { level: 1, channel: 'email', recipients: [ids.owen], eventId: ev } }]);
  });

  it('level 1 with no owner: everyone who can assign work and can see the machine, and nobody else', async () => {
    await escalated(await incident('M1', { owner: null }), 1);
    await consumer.pass(NOW);
    // ada (whole account) and nina (North). Not sam (South only), sue (suspended),
    // ivan (invited), owen (cannot assign), gina (another account).
    expect(to()).toEqual(['ada@acme.test', 'nina@acme.test']);
  });

  it('level 2: the owner and everyone who can assign work', async () => {
    await escalated(await incident('M1'), 2);
    await consumer.pass(NOW);
    expect(to()).toEqual(['ada@acme.test', 'nina@acme.test', 'owen@acme.test']);
    expect(mail.sent[0].subject).toContain('not resolved in time');
  });

  it('a site manager is told about a machine in their site: sam for M2, nina not', async () => {
    await escalated(await incident('M2', { owner: null }), 1, 'M2');
    await consumer.pass(NOW);
    expect(to()).toEqual(['ada@acme.test', 'sam@acme.test']);
  });

  it('two passes at once both settle, and each person gets one email', async () => {
    const ev = await escalated(await incident('M1'), 2);
    const results = await Promise.allSettled([consumer.pass(NOW), consumer.pass(NOW)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(to()).toEqual(['ada@acme.test', 'nina@acme.test', 'owen@acme.test']);
    expect((await owner.query(`SELECT count(*)::int AS n FROM notification_delivery WHERE event_id = $1`, [ev]))[0].n).toBe(3);
  });

  it('the database refuses a second delivery row for the same event, person and channel', async () => {
    const ev = await escalated(await incident('M1'), 1);
    await consumer.pass(NOW);
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `INSERT INTO notification_delivery (tenant_id, event_id, recipient_user_id, channel) VALUES ('acme',$1,$2,'email')`,
      [ev, ids.owen]))).rejects.toThrow(/uq_notification_delivery/);
  });

  it('an event type with no handler is never claimed', async () => {
    await owner.query(`INSERT INTO domain_event (event_type, tenant_id, subject, payload, occurred_at)
      VALUES ('scenario.activated.v1','acme','x','{}'::jsonb,$1)`, [NOW]);
    expect(await consumer.pass(NOW)).toEqual({ delivered: 0, retried: 0, failed: 0 });
    expect(await owner.query(`SELECT delivery_state, attempts FROM domain_event`)).toEqual([{ delivery_state: 'pending', attempts: 0 }]);
  });

  it('resolved since the escalation, or acknowledged since a level-1 one: nothing sent, and the timeline says why', async () => {
    const resolved = await incident('M1', { status: 'resolved' });
    const acked = await incident('M2', { status: 'acknowledged', acknowledged: true });
    const ev1 = await escalated(resolved, 2);
    const ev2 = await escalated(acked, 1, 'M2');
    await consumer.pass(NOW);
    expect(mail.sent).toEqual([]);
    expect([(await eventRow(ev1)).delivery_state, (await eventRow(ev2)).delivery_state]).toEqual(['delivered', 'delivered']);
    expect((await timeline(resolved))[0]).toMatchObject({ kind: 'notification_skipped', detail: { reason: 'resolved' } });
    expect((await timeline(acked))[0]).toMatchObject({ kind: 'notification_skipped', detail: { reason: 'acknowledged' } });
  });

  it('mail not accepted: retried after its backoff, then failed after the limit, and never again', async () => {
    mail.refuse.add('owen@acme.test');
    const ev = await escalated(await incident('M1'), 1);
    await consumer.pass(NOW);
    let row = await eventRow(ev);
    expect(row).toMatchObject({ delivery_state: 'pending', attempts: 1 });
    expect(row.last_error).toMatch(/1 of 1 email\(s\) were not accepted/);
    expect(new Date(row.next_attempt_at).getTime()).toBe(NOW.getTime() + 1 * MIN);

    // Before the backoff ends, a pass leaves it alone.
    expect(await consumer.pass(new Date(NOW.getTime() + 30_000))).toEqual({ delivered: 0, retried: 0, failed: 0 });

    let t = NOW.getTime();
    for (const wait of [1, 2, 4, 8]) { t += wait * MIN; await consumer.pass(new Date(t)); }
    row = await eventRow(ev);
    expect(row).toMatchObject({ delivery_state: 'failed', attempts: MAX_ATTEMPTS });
    await consumer.pass(new Date(t + 60 * MIN));
    expect((await eventRow(ev)).attempts).toBe(MAX_ATTEMPTS);
  });

  it('a send that failed for one person is retried for that person only', async () => {
    mail.refuse.add('nina@acme.test');
    const ev = await escalated(await incident('M1'), 2);
    await consumer.pass(NOW);
    expect(to()).toEqual(['ada@acme.test', 'owen@acme.test']);
    mail.refuse.clear();
    await consumer.pass(new Date(NOW.getTime() + 2 * MIN));
    expect(to()).toEqual(['ada@acme.test', 'nina@acme.test', 'owen@acme.test']);
    expect((await eventRow(ev)).delivery_state).toBe('delivered');
  });

  it('an escalation older than 24 hours is not sent; it is failed, saying why', async () => {
    const ev = await escalated(await incident('M1'), 1, 'M1', new Date(NOW.getTime() - 25 * 60 * MIN));
    expect(await consumer.pass(NOW)).toEqual({ delivered: 0, retried: 0, failed: 1 });
    expect(mail.sent).toEqual([]);
    expect(await eventRow(ev)).toMatchObject({ delivery_state: 'failed', last_error: EXPIRED_ERROR });
  });

  it('nobody able to receive it: failed, not retried, and the timeline says so', async () => {
    await owner.query(`UPDATE app_user SET status = 'suspended' WHERE role_slug <> 'operator' AND tenant_id = 'acme'`);
    const inc = await incident('M1', { owner: null });
    const ev = await escalated(inc, 1);
    await consumer.pass(NOW);
    expect(await eventRow(ev)).toMatchObject({ delivery_state: 'failed', attempts: 1 });
    expect((await timeline(inc))[0]).toMatchObject({ kind: 'notification_skipped', detail: { reason: 'no_recipient' } });
  });

  it('the database keeps a delivered event delivered, and an event what it was', async () => {
    const ev = await escalated(await incident('M1'), 1);
    await consumer.pass(NOW);
    await expect(owner.query(`UPDATE domain_event SET delivery_state = 'pending' WHERE id = $1`, [ev]))
      .rejects.toThrow(/delivered is final/);
    const [pending] = await owner.query(`INSERT INTO domain_event (event_type, tenant_id, subject, payload, occurred_at)
      VALUES ('scenario.activated.v1','acme','x','{}'::jsonb, now()) RETURNING id`);
    await expect(owner.query(`UPDATE domain_event SET payload = '{"forged":true}'::jsonb WHERE id = $1`, [pending.id]))
      .rejects.toThrow(/what happened cannot change/);
    await expect(owner.query(`UPDATE domain_event SET delivery_state = 'lost' WHERE id = $1`, [pending.id]))
      .rejects.toThrow(/ck_domain_event_delivery_state/);
  });

  it('one account cannot read another\'s delivery records', async () => {
    await escalated(await incident('M1'), 1);
    await consumer.pass(NOW);
    expect(await withTenantId(ds, 'globex', (m) => m.query(`SELECT * FROM notification_delivery`))).toEqual([]);
    expect((await withTenantId(ds, 'acme', (m) => m.query(`SELECT * FROM notification_delivery`))).length).toBe(1);
  });

  it('refuses a handler for an event type nothing writes', () => {
    const typo = { eventType: 'incident.escalted.v1', handle: async () => ({ kind: 'delivered' }) } as unknown as OutboxHandler;
    expect(() => new OutboxConsumer(ds, [typo])).toThrow(/No event type "incident.escalted.v1"/);
    expect(consumer.handledTypes).toEqual(['incident.escalated.v1']);
  });

  // Last: it takes the schema down a step and puts it back.
  it('IncidentNotifier1760900000000 down removes what it added, and up restores it', async () => {
    await undoMigrationNamed(owner, 'IncidentNotifier1760900000000');
    expect(await owner.query(`SELECT to_regclass('notification_delivery') AS t,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'domain_event' AND column_name = 'next_attempt_at') AS c`))
      .toEqual([{ t: null, c: 0 }]);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT to_regclass('notification_delivery')::text AS t`)).toEqual([{ t: 'notification_delivery' }]);
  });
});

describe('the escalation email', () => {
  const base = { machineName: 'DG-1', siteName: null, severity: 'critical', dueAt: null, now: new Date(), link: null };

  it('says which clock ran out and points at the incident screen without a link when none is configured', () => {
    const m = escalationEmail({ ...base, level: 2 });
    expect(m.subject).toBe('Escalated: critical incident on DG-1 not resolved in time');
    expect(m.text('Ada')).toContain('Open it from Incident Management in Things Alive.');
    expect(m.text('Ada')).toMatch(/^Hello Ada,/);
  });

  it('rounds the lateness to hours past two hours', () => {
    const now = new Date('2026-10-19T10:00:00Z');
    const m = escalationEmail({ ...base, level: 1, now, dueAt: new Date(now.getTime() - 5 * 60 * MIN) });
    expect(m.text('Ada')).toContain('now 5 hours overdue');
  });
});

