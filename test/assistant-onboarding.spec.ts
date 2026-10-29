import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AssistantModel, AssistantTurn, ModelReply, ToolDeclaration } from '../src/assistant/assistant-model';
import { AssistantProposalService, PROPOSAL_LIFETIME_MS } from '../src/assistant/assistant-proposal.service';
import { AssistantTools, MAX_PROPOSALS_PER_CHAT } from '../src/assistant/assistant-tools';
import { AssistantService } from '../src/assistant/assistant.service';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { withTenantId } from '../src/scope/tenant-session';
import { createTestDataSource, describeDb, undoMigrationNamed } from './db';

const SECRET = 'test-secret-assistant-onboarding';
const ISSUER = 'things-alive-assistant-onboarding-test';

type Input = { system: string; turns: AssistantTurn[]; tools: ToolDeclaration[] };

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
const calls = (...c: [string, Record<string, unknown>][]): ModelReply =>
  ({ text: null, calls: c.map(([name, args]) => ({ name, args })), tokens: 10 });

/**
 * The onboarding chat (task QCHAT2, G09): the assistant proposes, a person confirms,
 * and confirming runs the ordinary service as that person. What is tested is the
 * line between the two — that proposing changes nothing, that confirming does exactly
 * what was shown once, and that the database keeps it that way.
 */
describeDb('onboarding assistant: propose, then confirm', () => {
  let owner: DataSource;
  let app: INestApplication;
  let ds: DataSource;
  let tools: AssistantTools;
  let proposals: AssistantProposalService;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['admin'], isPlatformRole: false };
  const acme2: RequestScope = { tenantId: 'acme', userId: 'u-acme-2', roles: ['admin'], isPlatformRole: false };
  const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['admin'], isPlatformRole: false };
  // May add machines, may not fit loggers.
  const builder: RequestScope = {
    tenantId: 'acme', userId: 'u-builder', roles: ['builder'], isPlatformRole: false,
    capabilities: ['equipment.write', 'catalog.read', 'device.read'],
  };
  const ask = (text: string) => [{ role: 'user' as const, text }];
  const assistant = (model: AssistantModel) => new AssistantService(ds, tools, model, 100_000);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.AUTH_JWT_ISSUER = ISSUER;
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    for (const k of ['ASSISTANT_VERTEX_PROJECT', 'ASSISTANT_VERTEX_LOCATION', 'ASSISTANT_MODEL', 'ASSISTANT_GEMINI_API_KEY']) {
      delete process.env[k];
    }
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
    tools = app.get(AssistantTools);
    proposals = app.get(AssistantProposalService);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(
      `TRUNCATE TABLE "assistant_proposal", "assistant_usage", "device_inventory_event", "device_inventory",
        "equipment_placement_event", "equipment_profile", "plant" CASCADE`,
    );
    await owner.query(`INSERT INTO plant (tenant_id, code, name, status) VALUES ('acme', 'NORTH', 'North yard', 'active')`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
         VALUES ('acme', 'ta-2.0', 'EX-1', 'Excavator 1', 'client', 'active', 'basic', '{}'::jsonb)`,
    );
    await owner.query(
      `INSERT INTO device_inventory (imei, tenant_id, state) VALUES ('L1', 'acme', 'assigned'), ('L9', 'globex', 'assigned')`,
    );
  });

  const count = async (table: string, where = 'true') =>
    (await owner.query(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`))[0].n;

  it('proposes without doing: the reply carries the proposal, and nothing is created', async () => {
    const model = new ScriptedModel((_, n) => (n === 0
      ? calls(['list_sites', {}], ['propose_create_site', { code: 'SOUTH', name: 'South yard' }])
      : say('I have proposed adding South yard.')));
    const out = await assistant(model).onboarding(acme, ask('Add a site called South yard, code SOUTH'));

    expect(out.reply).toBe('I have proposed adding South yard.');
    expect(out.proposals.map((p) => [p.kind, p.status, p.summary])).toEqual([
      ['create_site', 'proposed', 'Add the site "South yard" (code SOUTH).'],
    ]);
    expect(await count('plant', `code = 'SOUTH'`)).toBe(0);
    // What the model was told back is that it waits, so it has no "done" to repeat.
    const told = model.seen[1].turns.at(-1)!;
    expect(told.role === 'tool' && told.results[1].result).toMatchObject({ status: 'waiting for the person to confirm' });
  });

  it('confirming does it through the ordinary service, as the person who confirmed', async () => {
    const p = await proposals.propose(acme, 'create_equipment', { code: 'GEN-1', name: 'Generator 1', siteCode: 'north' });
    const done = await proposals.confirm(acme2, p.id);

    expect(done).toMatchObject({ status: 'applied', decidedBy: 'u-acme-2', result: { sourceSystem: 'ta-2.0', code: 'GEN-1' } });
    expect(await owner.query(
      `SELECT e.name, e.created_by, pl.code AS site FROM equipment_profile e JOIN plant pl ON pl.id = e.plant_id WHERE e.external_id = 'GEN-1'`,
    )).toEqual([{ name: 'Generator 1', created_by: 'u-acme-2', site: 'NORTH' }]);
    expect(await count('equipment_placement_event')).toBe(1);
  });

  it('two confirms at once both settle, with one outcome, and the work happens once', async () => {
    const p = await proposals.propose(acme, 'fit_logger', { imei: 'L1', equipmentCode: 'EX-1' });
    const results = await Promise.allSettled([proposals.confirm(acme, p.id), proposals.confirm(acme2, p.id)]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [a, b] = results.map((r) => (r as PromiseFulfilledResult<{ status: string; decidedBy: string }>).value);
    expect(a.status).toBe('applied');
    expect(b).toEqual(a);
    expect(await count('device_inventory_event', `imei = 'L1' AND action = 'claim'`)).toBe(1);
  });

  it('a refusal from the service is the recorded outcome, and confirming again does not retry it', async () => {
    const p = await proposals.propose(acme, 'create_site', { code: 'NORTH', name: 'Another north' });
    const first = await proposals.confirm(acme, p.id);
    expect(first).toMatchObject({ status: 'failed', error: 'A site with the code "NORTH" already exists.' });

    await owner.query(`UPDATE plant SET code = 'NORTH-OLD' WHERE code = 'NORTH'`);
    expect(await proposals.confirm(acme, p.id)).toMatchObject({ status: 'failed' });
    expect(await count('plant', `code = 'NORTH'`)).toBe(0);
  });

  it('the database refuses an edit to what was proposed, and any change to a decided proposal', async () => {
    const p = await proposals.propose(acme, 'create_site', { code: 'SOUTH', name: 'South yard' });
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `UPDATE assistant_proposal SET payload = '{"code":"EVIL","name":"x"}'::jsonb WHERE id = $1`, [p.id],
    ))).rejects.toThrow(/what was proposed cannot change/);

    await proposals.reject(acme, p.id);
    await expect(withTenantId(ds, 'acme', (m) => m.query(
      `UPDATE assistant_proposal SET status = 'proposed', decided_at = NULL, decided_by = NULL WHERE id = $1`, [p.id],
    ))).rejects.toThrow(/already rejected; a decision is final/);
    await expect(owner.query(
      `INSERT INTO assistant_proposal (tenant_id, kind, payload, summary, status, proposed_by, expires_at)
         VALUES ('acme', 'create_site', '{}'::jsonb, 's', 'applied', 'u', now() + interval '1 day')`,
    )).rejects.toThrow(/ck_assistant_proposal_decided/);
  });

  it('a rejected proposal stays rejected: confirming it later does nothing', async () => {
    const p = await proposals.propose(acme, 'create_site', { code: 'SOUTH', name: 'South yard' });
    expect(await proposals.reject(acme, p.id)).toMatchObject({ status: 'rejected', decidedBy: 'u-acme' });
    expect(await proposals.confirm(acme, p.id)).toMatchObject({ status: 'rejected' });
    expect(await count('plant', `code = 'SOUTH'`)).toBe(0);
  });

  it('an expired proposal is recorded as expired on confirm, and not done', async () => {
    const then = new Date(Date.now() - PROPOSAL_LIFETIME_MS - 60_000);
    const p = await proposals.propose(acme, 'create_site', { code: 'SOUTH', name: 'South yard' }, then);
    expect(await proposals.confirm(acme, p.id)).toMatchObject({ status: 'expired' });
    expect(await count('plant', `code = 'SOUTH'`)).toBe(0);
  });

  it('confirming needs the capability the screen needs: a role that cannot fit loggers cannot confirm a fitting', async () => {
    const p = await proposals.propose(acme, 'fit_logger', { imei: 'L1', equipmentCode: 'EX-1' });
    await expect(proposals.confirm(builder, p.id)).rejects.toMatchObject({ status: 403 });
    expect(await owner.query(`SELECT status FROM assistant_proposal WHERE id = $1`, [p.id])).toEqual([{ status: 'proposed' }]);
    expect(await owner.query(`SELECT equipment_external_id FROM device_inventory WHERE imei = 'L1'`)).toEqual([{ equipment_external_id: null }]);
    // Nor can that role be offered the tool to propose one.
    expect(tools.available(builder, 'onboarding').map((t) => t.name)).not.toContain('propose_fit_logger');
  });

  it('another account can neither see nor decide a proposal', async () => {
    const p = await proposals.propose(acme, 'create_site', { code: 'SOUTH', name: 'South yard' });
    expect(await proposals.list(globex)).toEqual([]);
    await expect(proposals.confirm(globex, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(proposals.reject(globex, p.id)).rejects.toMatchObject({ status: 404 });
    expect(await owner.query(`SELECT status FROM assistant_proposal WHERE id = $1`, [p.id])).toEqual([{ status: 'proposed' }]);
  });

  it('the Ask AI chat cannot propose, even when the model calls a propose tool', async () => {
    expect(tools.available(acme, 'ask').map((t) => t.name).filter((n) => n.startsWith('propose_'))).toEqual([]);
    const model = new ScriptedModel((_, n) => (n === 0 ? calls(['propose_create_site', { code: 'X', name: 'X' }]) : say('no')));
    const out = await assistant(model).chat(acme, ask('make a site'));
    expect(out).not.toHaveProperty('proposals');
    expect(await count('assistant_proposal')).toBe(0);
  });

  it('a malformed proposal goes back to the model as an error and stores nothing', async () => {
    const model = new ScriptedModel((_, n) => (n === 0
      ? calls(['propose_create_equipment', { code: 'bad code!', name: 'x' }], ['propose_create_site', { name: 'No code' }])
      : say('Those were not valid.')));
    const out = await assistant(model).onboarding(acme, ask('add things'));
    const told = model.seen[1].turns.at(-1)!;
    expect(told.role === 'tool' && told.results.map((r) => r.result)).toEqual([
      { error: 'Machine code "bad code!" is not valid: letters, digits, dots, hyphens or underscores.' },
      { error: 'code is required.' },
    ]);
    expect(out.proposals).toEqual([]);
    expect(await count('assistant_proposal')).toBe(0);
  });

  it(`stops at ${MAX_PROPOSALS_PER_CHAT} proposals in one answer`, async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ['propose_create_site', { code: `S${i}`, name: `Site ${i}` }] as [string, Record<string, unknown>]);
    const model = new ScriptedModel((_, n) => (n < 3 ? calls(...twelve.slice(n * 5, n * 5 + 5)) : say('ok')));
    const out = await assistant(model).onboarding(acme, ask('add twelve sites'));
    expect(out.proposals).toHaveLength(MAX_PROPOSALS_PER_CHAT);
    expect(await count('assistant_proposal')).toBe(MAX_PROPOSALS_PER_CHAT);
  });

  it('a whole setup: machine proposed and confirmed, then a logger fitted to it', async () => {
    const machine = await proposals.propose(acme, 'create_equipment', { code: 'GEN-2', name: 'Generator 2' });
    await proposals.confirm(acme, machine.id);
    const fit = await proposals.propose(acme, 'fit_logger', { imei: 'L1', equipmentCode: 'GEN-2' });
    expect(await proposals.confirm(acme, fit.id)).toMatchObject({ status: 'applied', result: { imei: 'L1', equipmentCode: 'GEN-2' } });
    expect(await proposals.list(acme, 'applied')).toHaveLength(2);
  });

  describe('naming what is here', () => {
    beforeEach(async () => {
      await owner.query(`TRUNCATE TABLE "client_equipment_class" CASCADE`);
      await owner.query(
        `INSERT INTO client_equipment_class (tenant_id, slug, name) VALUES ('acme', 'ashok-genset-180', 'Ashok Leyland genset 180')`,
      );
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness, equipment_class_slug, plant_id)
           SELECT 'acme', 'ta-2.0', 'GEN-2', 'Genset 2', 'client', 'active', 'basic', '{}'::jsonb, 'ashok-genset-180', id
             FROM plant WHERE code = 'NORTH'`,
      );
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
           VALUES ('globex', 'ta-2.0', 'G-1', 'Globex rig', 'client', 'active', 'basic', '{}'::jsonb)`,
      );
    });

    it('list_equipment gives the site and type by name, keeping the ids other tools need', async () => {
      const out = await tools.run(acme, 'list_equipment', {}) as Record<string, unknown>[];
      expect(out.find((e) => e.code === 'GEN-2')).toMatchObject({
        site: 'North yard', siteCode: 'NORTH', type: 'Ashok Leyland genset 180', typeSlug: 'ashok-genset-180',
      });
      expect(out.find((e) => e.code === 'EX-1')).toMatchObject({ site: null, type: null });
      expect(JSON.stringify(out)).not.toContain('Globex');
    });

    it('unfinished_machines lists every unfinished machine here in one call, by name, with what it waits on', async () => {
      expect(tools.available(acme, 'onboarding').map((t) => t.name)).toContain('unfinished_machines');
      expect(tools.available(acme, 'ask').map((t) => t.name)).not.toContain('unfinished_machines');

      const out = await tools.run(acme, 'unfinished_machines', {}, { profile: 'onboarding', proposals: [] }) as Record<string, unknown>[];
      expect(out.map((m) => m.code).sort()).toEqual(['EX-1', 'GEN-2']);
      const gen = out.find((m) => m.code === 'GEN-2')!;
      expect(gen).toMatchObject({ site: 'North yard', type: 'Ashok Leyland genset 180', hasLogger: false });
      expect(gen.notDone).toContain('device');
      expect(typeof gen.meaning).toBe('string');
    });

    it('a machine on a site the caller may not see is listed, but its site is not named', async () => {
      const elsewhere: RequestScope = { ...acme, plantIds: ['00000000-0000-4000-8000-00000000beef'] };
      const out = await tools.run(elsewhere, 'unfinished_machines', {}, { profile: 'onboarding', proposals: [] }) as Record<string, unknown>[];
      expect(out.find((m) => m.code === 'GEN-2')).toMatchObject({ site: null, siteCode: null });
      expect(JSON.stringify(out)).not.toContain('North yard');
    });
  });

  describe('over HTTP', () => {
    const token = () => app.get(JwtService).signAsync(
      { sub: '00000000-0000-4000-8000-0000000000b1', client_id: 'acme', roles: ['admin'] }, { secret: SECRET, issuer: ISSUER },
    );
    const auth = async () => `Bearer ${await token()}`;

    it('the onboarding chat answers 503 while no model is configured', async () => {
      const res = await request(app.getHttpServer()).post('/api/v1/assistant/onboarding/chat')
        .set('Authorization', await auth()).send({ messages: ask('hi') });
      expect(res.status).toBe(503);
    });

    it('confirm takes a proposal id and returns the decided proposal; a non-id is refused', async () => {
      const p = await proposals.propose(acme, 'create_site', { code: 'SOUTH', name: 'South yard' });
      const res = await request(app.getHttpServer()).post(`/api/v1/assistant/proposals/${p.id}/confirm`).set('Authorization', await auth());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: p.id, status: 'applied' });
      expect((await request(app.getHttpServer()).post('/api/v1/assistant/proposals/not-an-id/confirm')
        .set('Authorization', await auth())).status).toBe(400);
    });
  });

  // Last: it takes the schema down a step and puts it back.
  it('AssistantProposal1760700000000 down drops the table and its guard, and up brings them back', async () => {
    await undoMigrationNamed(owner, 'AssistantProposal1760700000000');
    expect(await owner.query(`SELECT to_regclass('assistant_proposal') AS t, to_regproc('assistant_proposal_guard') AS f`))
      .toEqual([{ t: null, f: null }]);
    await owner.runMigrations({ transaction: 'all' });
    expect(await owner.query(`SELECT to_regclass('assistant_proposal')::text AS t`)).toEqual([{ t: 'assistant_proposal' }]);
  });
});
