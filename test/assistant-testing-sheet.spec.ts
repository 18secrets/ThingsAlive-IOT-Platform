import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AssistantModel, AssistantTurn, ModelReply, ToolDeclaration } from '../src/assistant/assistant-model';
import { AssistantTools } from '../src/assistant/assistant-tools';
import { AssistantService } from '../src/assistant/assistant.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { createTestDataSource, describeDb } from './db';

type Input = { system: string; turns: AssistantTurn[]; tools: ToolDeclaration[] };

/** A model that does what the test says, and remembers what it was shown. */
class ScriptedModel implements AssistantModel {
  readonly name = 'scripted';
  readonly seen: Input[] = [];
  constructor(private readonly step: (input: Input, n: number) => ModelReply) {}
  async generate(input: Input): Promise<ModelReply> {
    this.seen.push({ ...input, turns: [...input.turns] });
    return this.step(input, this.seen.length - 1);
  }
}

const say = (text: string): ModelReply => ({ text, calls: [], tokens: 10 });
const call = (name: string, args: Record<string, unknown> = {}): ModelReply => ({ text: null, calls: [{ name, args }], tokens: 10 });
const ask = (text: string) => [{ role: 'user' as const, text }];

jest.setTimeout(60_000);

/**
 * The Ask AI testing sheet of 22 Nov 2026. Each case is the sheet's own: the question the
 * tester asked, the data that was there, and what the chat got wrong — a job the page
 * calls open reported as none, seven loggers with no data reported as "none offline",
 * machines listed as devices, a site's town unknown, and a user with no Work Orders menu
 * reading every job. The model is scripted; the tools and their sessions are real.
 */
describeDb('Ask AI testing sheet, 22 Nov 2026', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let tools: AssistantTools;

  // A static-table caller: no role row, so no menu to follow.
  const admin: RequestScope = { tenantId: 'acme', userId: 'u-admin', roles: ['admin'], isPlatformRole: false };
  // A role-row caller who may work jobs but whose menu has no Work Orders (TC #61).
  const noJobsMenu: RequestScope = {
    tenantId: 'acme', userId: 'u-site', roles: ['site-lead'], isPlatformRole: false,
    capabilities: ['catalog.read', 'action.work', 'prediction.read', 'device.read'],
  };
  const withJobsMenu: RequestScope = { ...noJobsMenu, userId: 'u-lead', roles: ['jobs-lead'] };
  // Limited to one machine, as a site manager with machines assigned is.
  const oneMachine: RequestScope = { ...admin, userId: 'u-one', equipmentIds: ['GEN-1'] };

  const service = (model: AssistantModel) => new AssistantService(ds, tools, model, 100_000);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    for (const k of ['ASSISTANT_VERTEX_PROJECT', 'ASSISTANT_VERTEX_LOCATION', 'ASSISTANT_MODEL', 'ASSISTANT_GEMINI_API_KEY']) {
      delete process.env[k];
    }
    process.env.AUTH_JWT_SECRET = 'test-secret-ask-sheet';
    process.env.AUTH_JWT_ISSUER = 'things-alive-ask-sheet-test';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
    tools = app.get(AssistantTools);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`TRUNCATE TABLE "assistant_usage", "work_order", "device_inventory", "equipment_profile", "plant", "tenant_role" CASCADE`);
    const [chennai] = await owner.query(
      `INSERT INTO plant (tenant_id, code, name, address) VALUES ('acme', 'DMU', 'Device Manufacturing unit', 'Guindy, Chennai, Tamilnadu') RETURNING id`,
    );
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness, plant_id)
         VALUES ('acme', 'ta-2.0', 'GEN-1', 'Generator 1', 'client', 'active', 'basic', '{}'::jsonb, $1),
                ('acme', 'ta-2.0', 'TRAC-1', 'Mahindra 4x4 Tractor', 'client', 'active', 'basic', '{}'::jsonb, NULL)`,
      [chennai.id],
    );
    await owner.query(
      `INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape, allowed_tabs) VALUES
         ('acme', 'site-lead', 'Site lead', $1, 'tenant', '{dashboard,admin,admin-equipment}'),
         ('acme', 'jobs-lead', 'Jobs lead', $1, 'tenant', '{dashboard,work-orders,alerts}')`,
      [noJobsMenu.capabilities],
    );
  });

  const job = (reference: string, status: string, dueAt: string | null) => owner.query(
    // A completed job carries what was done (ck_work_order_resolution).
    `INSERT INTO work_order (tenant_id, reference, source_system, external_id, title, raised_by, status, due_at, resolution)
       VALUES ('acme', $1, 'ta-2.0', 'TRAC-1', 'Oil change', 'u', $2, $3, CASE WHEN $2 = 'completed' THEN 'Done' END)`,
    [reference, status, dueAt],
  );

  describe('jobs: the page\'s "Open" is the database\'s "created" (TC #29, #7)', () => {
    it('asked for open jobs, the not-started ones come back, said as open, with overdue marked', async () => {
      await job('WO-000001', 'created', '2026-10-31T00:00:00Z');
      await job('WO-000002', 'completed', '2026-10-20T00:00:00Z');
      await job('WO-000004', 'created', '2099-11-29T00:00:00Z');
      const open = await tools.run(admin, 'list_work_orders', { status: ['open'] }) as Record<string, unknown>[];
      expect(open.map((w) => [w.reference, w.status, w.overdue]).sort()).toEqual([
        ['WO-000001', 'open', true], ['WO-000004', 'open', false],
      ]);
      // A finished job is never overdue, however old its due date.
      const done = await tools.run(admin, 'list_work_orders', { status: ['completed'] }) as Record<string, unknown>[];
      expect(done).toEqual([expect.objectContaining({ reference: 'WO-000002', overdue: false })]);
    });
  });

  describe('loggers are not machines, and silence is offline (TC #4, #5, #48)', () => {
    beforeEach(async () => {
      await owner.query(
        `INSERT INTO device_inventory (imei, tenant_id, state, equipment_external_id) VALUES
           ('753753753951951', 'acme', 'assigned', 'GEN-1'),
           ('753753753951952', 'acme', 'assigned', NULL)`,
      );
    });

    it('every logger is listed, and a fitted one silent all week is offline, as the Dashboard counts it', async () => {
      const out = await tools.run(admin, 'logger_health', {}) as Record<string, any>;
      expect(out).toMatchObject({ offline: 1, online: 0, notFitted: 1, total: 2, byState: { offline: 1, 'not fitted': 1 } });
      expect(out.loggers.map((l: any) => [l.imei, l.fitted, l.machine, l.state])).toEqual([
        ['753753753951951', true, 'GEN-1', 'offline'], ['753753753951952', false, null, 'not fitted'],
      ]);
      expect(out.loggers[0].detail).toMatch(/nothing received in the last 7 days/);
      // The Tamil and Hindi answers repeated "dark" word for word (TC #48).
      expect(JSON.stringify(out)).not.toMatch(/"dark"/);
    });

    it('asked for offline loggers, the silent fitted one comes back, never "none"', async () => {
      const out = await tools.run(admin, 'logger_health', { state: ['offline'] }) as Record<string, any>;
      expect(out.total).toBe(1);
      expect(out.loggers.map((l: any) => l.imei)).toEqual(['753753753951951']);
      expect(out.offline).toBe(1);
    });

    it('a user limited to one machine sees only the logger fitted to it', async () => {
      const out = await tools.run(oneMachine, 'logger_health', {}) as Record<string, any>;
      expect(out.loggers.map((l: any) => l.imei)).toEqual(['753753753951951']);
    });
  });

  it('a machine\'s site comes with its address, so "which is in Chennai?" can be answered (TC #3)', async () => {
    const rows = await tools.run(admin, 'list_equipment', {}) as Record<string, unknown>[];
    expect(rows.find((r) => r.code === 'GEN-1')).toMatchObject({
      site: 'Device Manufacturing unit', siteAddress: 'Guindy, Chennai, Tamilnadu',
    });
  });

  describe('the console chat follows the caller\'s menu (TC #61)', () => {
    it('a role with no Work Orders menu is not offered jobs, and a call to them anyway is refused', async () => {
      await job('WO-000001', 'created', null);
      const model = new ScriptedModel((_, n) => (n === 0 ? call('list_work_orders') : say('I cannot see jobs.')));
      await service(model).chat(noJobsMenu, ask('List all work orders, including completed ones.'), new Date(), { followMenu: true });
      const offered = model.seen[0].tools.map((t) => t.name);
      expect(offered).not.toContain('list_work_orders');
      expect(offered).not.toContain('list_alerts');
      expect(offered).toContain('list_equipment');
      const turn = model.seen[1].turns.at(-1)!;
      expect(turn).toEqual({ role: 'tool', results: [{ name: 'list_work_orders', result: { error: 'No tool "list_work_orders" is available.' } }] });
      expect(JSON.stringify(model.seen)).not.toContain('WO-000001');
    });

    it('a role whose menu has Work Orders is offered them', async () => {
      const model = new ScriptedModel(() => say('ok'));
      await service(model).chat(withJobsMenu, ask('List open work orders'), new Date(), { followMenu: true });
      expect(model.seen[0].tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_work_orders', 'list_alerts']));
    });

    it('the machine page drops its alert and job lists for a menu without them', async () => {
      const page = await tools.run(noJobsMenu, 'machine_page', { sourceSystem: 'ta-2.0', code: 'TRAC-1' },
        { profile: 'ask', proposals: [], pages: ['dashboard'] }) as { widgets: { widgetType: string }[] };
      expect(page.widgets.length).toBeGreaterThan(0);
      expect(page.widgets.map((w) => w.widgetType)).not.toEqual(expect.arrayContaining(['work_order_list']));
      expect(page.widgets.map((w) => w.widgetType)).not.toEqual(expect.arrayContaining(['alert_list']));
    });

    it('Vani, which does not ask to follow the menu, is unchanged', async () => {
      const model = new ScriptedModel(() => say('ok'));
      await service(model).chat(noJobsMenu, ask('Any jobs?'));
      expect(model.seen[0].tools.map((t) => t.name)).toContain('list_work_orders');
    });

    it('a caller with no role row has no menu to follow, and is narrowed by capability alone', async () => {
      const model = new ScriptedModel(() => say('ok'));
      await service(model).chat(admin, ask('Any jobs?'), new Date(), { followMenu: true });
      expect(model.seen[0].tools.map((t) => t.name)).toContain('list_work_orders');
    });
  });

  it('the last round tells the model to answer with what it has (TC #63)', async () => {
    const model = new ScriptedModel((input) => (input.tools.length ? call('list_equipment') : say('Here is what I found.')));
    const out = await service(model).chat(admin, ask('List open work orders and what alerts are on GEN-1?'));
    expect(out.reply).toBe('Here is what I found.');
    expect(model.seen.at(-1)!.system).toMatch(/This is your last step/);
    expect(model.seen[0].system).not.toMatch(/This is your last step/);
  });

  it('the rules say missing data is not good news, and the assistant speaks of itself when refusing (TC #5, #6, #17)', async () => {
    const model = new ScriptedModel(() => say('ok'));
    await service(model).chat(admin, ask('Which devices are offline?'));
    const system = model.seen[0].system;
    expect(system).toMatch(/Missing data is not good news/);
    expect(system).toMatch(/never "you cannot"/);
    expect(system).not.toMatch(/- You cannot change anything/);
  });
});
