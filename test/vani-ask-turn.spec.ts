import { ConflictException, INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AssistantModel, AssistantTurn, ModelReply, ToolDeclaration } from '../src/assistant/assistant-model';
import { AssistantTools } from '../src/assistant/assistant-tools';
import { AssistantService } from '../src/assistant/assistant.service';
import { SCOPE_RESOLVER, ScopeResolver } from '../src/auth/scope-resolver';
import { createApp } from '../src/main';
import { DEFAULT_MAX_IN_FLIGHT, maxInFlight, REFUSALS, VaniAskService } from '../src/vani/vani-ask.service';
import { createTestDataSource, describeDb } from './db';

/**
 * A question Vani retries is answered once (plan Phase 6, `turn_id`).
 *
 * Vani retries when it hears nothing back, and on a phone call the likeliest reason is
 * that the first answer is still being worked out. So the case that matters is the two
 * arriving together while the model is still thinking, not one after the other — the
 * model here takes its time on purpose, and counts how often it was asked.
 */
type Input = { system: string; turns: AssistantTurn[]; tools: ToolDeclaration[] };

class SlowModel implements AssistantModel {
  readonly name = 'slow';
  asked = 0;
  constructor(private readonly words: string, private readonly ms = 300) {}
  async generate(_input: Input): Promise<ModelReply> {
    this.asked += 1;
    await new Promise((r) => setTimeout(r, this.ms));
    return { text: `${this.words} (${this.asked})`, calls: [], tokens: 10 };
  }
}

describeDb('vani ask: a retried question is answered once', () => {
  let owner: DataSource;
  let ds: DataSource;
  let app: INestApplication;
  let tools: AssistantTools;
  let resolver: ScopeResolver;
  const env = { VANI_ASK_ENABLED: 'true' };
  const SRC = 'ta-2.0';

  const service = (model: AssistantModel) => new VaniAskService(ds, resolver, new AssistantService(ds, tools, model, 10_000));
  const body = (over: Record<string, unknown> = {}) => ({
    account_id: 'usa-test-01', conversation_id: 'conv-1', caller_phone: '+12012031340',
    question: 'Is DG-01 safe to keep running?', turn_id: 'turn-1', ...over,
  });
  const turns = (): Promise<any[]> => owner.query(`SELECT * FROM vani_conversation_turn ORDER BY created_at, id`);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-vani-ask-turn';
    process.env.AUTH_JWT_ISSUER = 'things-alive-vani-ask-turn-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    for (const k of ['ASSISTANT_VERTEX_PROJECT', 'ASSISTANT_VERTEX_LOCATION', 'ASSISTANT_MODEL', 'ASSISTANT_GEMINI_API_KEY']) {
      delete process.env[k];
    }
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
    tools = app.get(AssistantTools);
    resolver = app.get(SCOPE_RESOLVER);

    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('usa-test', 'USA Test Client')`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
         VALUES ('usa-test', $1, 'DG-01', 'Diesel Generator DG-01', 'client', 'active', 'basic', '{}'::jsonb)`, [SRC]);
    await owner.query(`INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('usa-test', 'usa-test-01')`);
    await owner.query(
      `INSERT INTO vani_machine_link (tenant_id, source_system, external_id, machine_id, spoken_name)
         VALUES ('usa-test', $1, 'DG-01', 'dg-01', 'Diesel Generator DG-01')`, [SRC]);
    await owner.query(`INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape)
      VALUES ('usa-test', 'admin', 'Admin', $1::text[], 'tenant')`, [['prediction.read', 'catalog.read']]);
    await owner.query(
      `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status, phone)
         VALUES ('usa-test', 'deepak@usa-test.example', 'Deepak', 'admin', 'active', '+12012031340')`);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`DELETE FROM vani_conversation_turn`);
    await owner.query(`DELETE FROM assistant_usage`);
  });

  it('says the same words to a retry, without asking the model again', async () => {
    const model = new SlowModel('Yes, until the inspection.', 0);
    const first = await service(model).ask(body(), env);
    const again = await service(model).ask(body(), env);

    expect(first).toMatchObject({ status: 'answered', answer: 'Yes, until the inspection. (1)', machine: { machine_id: 'dg-01' } });
    expect(again).toEqual(first);
    expect(model.asked).toBe(1);
    expect(await turns()).toHaveLength(1);
  });

  it('answers once when the same question arrives twice at the same moment', async () => {
    const model = new SlowModel('Yes, until the inspection.');
    const svc = service(model);
    const results = await Promise.allSettled([svc.ask(body(), env), svc.ask(body(), env)]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [a, b] = results.map((r) => (r as PromiseFulfilledResult<unknown>).value);
    expect(a).toEqual(b);
    expect(model.asked).toBe(1);
    const rows = await turns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turn_id: 'turn-1', status: 'answered', tokens: 10 });
  });

  it('refuses a turn id reused for a different question, and keeps the first answer', async () => {
    const model = new SlowModel('Yes.', 0);
    await service(model).ask(body(), env);
    await expect(service(model).ask(body({ question: 'What about its fuel?' }), env)).rejects.toBeInstanceOf(ConflictException);
    await expect(service(model).ask(body({ caller_phone: '+12025550111' }), env)).rejects.toBeInstanceOf(ConflictException);

    expect(model.asked).toBe(1);
    expect((await turns()).map((t) => t.question)).toEqual(['Is DG-01 safe to keep running?']);
  });

  it('treats the same turn id in another conversation as another question', async () => {
    const model = new SlowModel('Yes.', 0);
    await service(model).ask(body(), env);
    await service(model).ask(body({ conversation_id: 'conv-2' }), env);
    expect(model.asked).toBe(2);
    expect(await turns()).toHaveLength(2);
  });

  it('answers every time when Vani sends no turn id, as before', async () => {
    const model = new SlowModel('Yes.', 0);
    await service(model).ask(body({ turn_id: undefined }), env);
    await service(model).ask(body({ turn_id: undefined }), env);
    expect(model.asked).toBe(2);
    expect((await turns()).map((t) => t.turn_id)).toEqual([null, null]);
  });

  describe('how many at once', () => {
    const tight = { ...env, VANI_ASK_MAX_IN_FLIGHT: '1' };

    it('tells a caller at once that it is busy when the limit is reached, and records nothing for it', async () => {
      const model = new SlowModel('Yes.');
      const svc = service(model);
      const [first, second] = await Promise.all([
        svc.ask(body({ turn_id: 'turn-a' }), tight),
        svc.ask(body({ turn_id: 'turn-b', question: 'And its fuel?' }), tight),
      ]);

      expect(first).toMatchObject({ status: 'answered' });
      expect(second).toEqual({ conversation_id: 'conv-1', status: 'refused', reason: 'busy', answer: REFUSALS.busy });
      expect(model.asked).toBe(1);
      expect((await turns()).map((t) => t.turn_id)).toEqual(['turn-a']);
    });

    it('answers the busy question when it is asked again, once there is room', async () => {
      const model = new SlowModel('Yes.', 50);
      const svc = service(model);
      await Promise.all([
        svc.ask(body({ turn_id: 'turn-a' }), tight),
        svc.ask(body({ turn_id: 'turn-b', question: 'And its fuel?' }), tight),
      ]);
      const retry = await svc.ask(body({ turn_id: 'turn-b', question: 'And its fuel?' }), tight);
      expect(retry).toMatchObject({ status: 'answered' });
      expect((await turns()).map((t) => t.turn_id)).toEqual(['turn-a', 'turn-b']);
    });

    it('gives the room back when an answer fails', async () => {
      const failing: AssistantModel = { name: 'broken', generate: async () => { throw new Error('model exploded'); } };
      // However it ends, thrown or spoken as a refusal, the room must come back.
      await service(failing).ask(body(), tight).catch(() => undefined);
      const svc = service(new SlowModel('Yes.', 0));
      await expect(svc.ask(body({ turn_id: 'turn-2' }), tight)).resolves.toMatchObject({ status: 'answered' });
    });

    it('refuses a limit that is not a whole number of at least one', () => {
      expect(maxInFlight({})).toBe(DEFAULT_MAX_IN_FLIGHT);
      expect(maxInFlight({ VANI_ASK_MAX_IN_FLIGHT: '8' })).toBe(8);
      for (const bad of ['0', '-1', '2.5', 'lots']) {
        expect(() => maxInFlight({ VANI_ASK_MAX_IN_FLIGHT: bad })).toThrow(/VANI_ASK_MAX_IN_FLIGHT/);
      }
    });
  });

  it('is refused by the database a second row for the same turn', async () => {
    await service(new SlowModel('Yes.', 0)).ask(body(), env);
    await expect(owner.query(
      `INSERT INTO vani_conversation_turn (tenant_id, conversation_id, turn_id, caller_phone, question, answer, status, reason)
         VALUES ('usa-test', 'conv-1', 'turn-1', '+12012031340', 'Is DG-01 safe to keep running?', 'No.', 'refused', 'incomplete')`,
    )).rejects.toThrow(/uq_vani_turn_turn_id/);
  });
});
