import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AssistantModel, AssistantTurn, ModelReply, ToolDeclaration } from '../src/assistant/assistant-model';
import { AssistantTools } from '../src/assistant/assistant-tools';
import { AssistantService } from '../src/assistant/assistant.service';
import { SCOPE_RESOLVER, ScopeResolver } from '../src/auth/scope-resolver';
import { createApp } from '../src/main';
import { namedIn, REFUSALS, spoken, VaniAskService } from '../src/vani/vani-ask.service';
import { createTestDataSource, describeDb } from './db';

/**
 * The analysis tool Vani asks on a caller's behalf (plan Phase 6).
 *
 * The model is scripted; everything it touches is real — the caller found by phone,
 * the scope the same resolver gives a signed-in user, the assistant's own tools reading
 * the database through that scope, the budget, and the turn log. What is worth proving
 * is the filtering: who is answered, about which machine, and that a tool run for a
 * caller cannot see a machine they are not assigned to.
 */
type Input = { system: string; turns: AssistantTurn[]; tools: ToolDeclaration[] };

class ScriptedModel implements AssistantModel {
  readonly name = 'scripted';
  readonly seen: Input[] = [];
  constructor(private readonly step: (input: Input, n: number) => ModelReply | Promise<ModelReply>) {}
  async generate(input: Input): Promise<ModelReply> {
    this.seen.push({ ...input, turns: [...input.turns] });
    return this.step(input, this.seen.length - 1);
  }
}
const say = (text: string): ModelReply => ({ text, calls: [], tokens: 10 });
const call = (name: string, args: Record<string, unknown> = {}): ModelReply => ({ text: null, calls: [{ name, args }], tokens: 10 });
/** The words of the last question the model was shown. */
const lastQuestion = (m: ScriptedModel) => {
  const turns = m.seen[0].turns;
  const t = turns[turns.length - 1];
  return t.role === 'user' ? t.text : '';
};

describe('vani ask: the small parts', () => {
  const linked = [
    { external_id: 'DG-01', machine_id: 'dg-01', spoken_name: 'Diesel Generator DG-01' },
    { external_id: 'DG-02', machine_id: 'dg-02', spoken_name: 'Diesel Generator DG-02' },
  ];

  it('finds the machine a question names, by the longest name that matches', () => {
    expect(namedIn('How is diesel generator DG-02 doing?', linked)?.external_id).toBe('DG-02');
    expect(namedIn('and dg-01?', linked)?.external_id).toBe('DG-01');
    expect(namedIn('How are my generators?', linked)).toBeNull();
  });

  it('chooses no machine when two are named equally well', () => {
    expect(namedIn('Compare DG-01 and DG-02', linked)).toBeNull();
  });

  it('turns whatever the model wrote into one spoken line', () => {
    expect(spoken('**Yes.** Two things:\n- the bearing is hot\n- fuel is low')).toBe('Yes. Two things: the bearing is hot fuel is low');
  });
});

describeDb('vani ask: answered as the person on the phone', () => {
  let owner: DataSource;
  let ds: DataSource;
  let app: INestApplication;
  let tools: AssistantTools;
  let resolver: ScopeResolver;
  let alertId: string;
  const ids: Record<string, string> = {};
  const env = { VANI_ASK_ENABLED: 'true' };
  const SRC = 'ta-2.0';

  const service = (model: AssistantModel | null, limit = 10_000) =>
    new VaniAskService(ds, resolver, new AssistantService(ds, tools, model, limit));
  const body = (over: Record<string, unknown> = {}) => ({
    account_id: 'usa-test-01', conversation_id: 'conv-1', caller_phone: '+12012031340',
    question: 'Is it safe to keep running?', ...over,
  });
  const turns = (): Promise<any[]> => owner.query(`SELECT * FROM vani_conversation_turn ORDER BY created_at, id`);

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-vani-ask';
    process.env.AUTH_JWT_ISSUER = 'things-alive-vani-ask-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    // Never a real model from a developer's .env: these tests script it.
    for (const k of ['ASSISTANT_VERTEX_PROJECT', 'ASSISTANT_VERTEX_LOCATION', 'ASSISTANT_MODEL', 'ASSISTANT_GEMINI_API_KEY']) {
      delete process.env[k];
    }
    app = await createApp({ database: true });
    await app.init();
    ds = app.get(DataSource);
    tools = app.get(AssistantTools);
    resolver = app.get(SCOPE_RESOLVER);

    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('usa-test', 'USA Test Client'), ('globex', 'Globex')`);
    for (const [tenant, ext, name] of [
      ['usa-test', 'DG-01', 'Diesel Generator DG-01'], ['usa-test', 'DG-02', 'Diesel Generator DG-02'],
      ['globex', 'GX-9', 'Globex secret rig'],
    ]) {
      await owner.query(
        `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
           VALUES ($1, $2, $3, $4, 'client', 'active', 'basic', '{}'::jsonb)`, [tenant, SRC, ext, name]);
    }
    await owner.query(`INSERT INTO vani_account_link (tenant_id, vani_account_id) VALUES ('usa-test', 'usa-test-01')`);
    for (const n of ['01', '02']) {
      await owner.query(
        `INSERT INTO vani_machine_link (tenant_id, source_system, external_id, machine_id, spoken_name)
           VALUES ('usa-test', $1, $2, $3, $4)`, [SRC, `DG-${n}`, `dg-${n}`, `Diesel Generator DG-${n}`]);
    }
    const caps = ['prediction.read', 'catalog.read'];
    await owner.query(`INSERT INTO tenant_role (tenant_id, slug, name, capabilities, scope_shape)
      VALUES ('usa-test', 'admin', 'Admin', $1::text[], 'tenant'), ('usa-test', 'operator', 'Operator', $1::text[], 'equipment')`, [caps]);
    const user = async (key: string, role: string, phone: string, status = 'active') => {
      const [u] = await owner.query(
        `INSERT INTO app_user (tenant_id, email, full_name, role_slug, status, phone) VALUES ('usa-test', $1, $2, $3, $4, $5) RETURNING id`,
        [`${key}@usa-test.example`, key, role, status, phone]);
      ids[key] = u.id;
    };
    await user('Deepak', 'admin', '+12012031340');
    // Stored without the "+": still the same E.164 number when Vani sends it.
    await user('Olga', 'operator', '12025550111');
    await user('Ivan', 'admin', '+12025550199', 'invited');
    await owner.query(
      `INSERT INTO user_equipment_access (tenant_id, user_id, source_system, equipment_external_id) VALUES ('usa-test', $1, $2, 'DG-02')`,
      [ids.Olga, SRC]);

    const [a] = await owner.query(
      `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
         VALUES ('usa-test', gen_random_uuid(), 'Main bearing vibration rising', $1, 'DG-01', 'critical', 'vibration high', '{}'::jsonb, 'open', now())
       RETURNING id`, [SRC]);
    alertId = a.id;
    await owner.query(
      `INSERT INTO vani_call (tenant_id, alert_event_id, vani_account_id, machine_id, severity, request, state)
         VALUES ('usa-test', $1, 'usa-test-01', 'dg-01', 'critical', '{}'::jsonb, 'accepted')`, [alertId]);
  }, 60_000);

  afterAll(async () => { delete process.env.VANI_CALLBACK_SECRET; await app?.close(); await owner?.destroy(); });

  beforeEach(async () => {
    await owner.query(`DELETE FROM vani_conversation_turn`);
    await owner.query(`DELETE FROM assistant_usage`);
  });

  describe('who is answered', () => {
    it('answers a known caller about the machine the call was placed for, in one spoken line', async () => {
      const model = new ScriptedModel((_, n) => (n === 0
        ? call('list_alerts', { equipmentCode: 'DG-01' })
        : say('**Yes**, for now.\n- Bearing vibration is high, so book the inspection this week.')));
      const out = await service(model).ask(body({ event_id: alertId }), env);

      expect(out).toEqual({
        conversation_id: 'conv-1', status: 'answered',
        answer: 'Yes, for now. Bearing vibration is high, so book the inspection this week.',
        machine: { machine_id: 'dg-01', name: 'Diesel Generator DG-01' },
      });
      expect(lastQuestion(model)).toContain('The caller is Deepak.');
      expect(lastQuestion(model)).toContain('"Diesel Generator DG-01" (code DG-01)');
      expect(lastQuestion(model)).toMatch(/Is it safe to keep running\?$/);

      const [t] = await turns();
      expect(t).toMatchObject({
        tenant_id: 'usa-test', user_id: ids.Deepak, external_id: 'DG-01', alert_event_id: alertId,
        status: 'answered', reason: null, tools_used: ['list_alerts'], tokens: 20,
      });
    });

    it('keeps talking about the same machine, and remembers what was said', async () => {
      await service(new ScriptedModel(() => say('It is running at 62 percent load.'))).ask(body({ event_id: alertId }), env);
      const model = new ScriptedModel(() => say('Fuel is at 40 percent.'));
      const out = await service(model).ask(body({ question: 'And its fuel?' }), env);

      expect(out.machine).toEqual({ machine_id: 'dg-01', name: 'Diesel Generator DG-01' });
      expect(lastQuestion(model)).toContain('"Diesel Generator DG-01"');
      const shown = model.seen[0].turns;
      expect(shown[0]).toEqual({ role: 'user', text: 'Is it safe to keep running?' });
      expect(shown[1]).toEqual({ role: 'model', text: 'It is running at 62 percent load.' });
    });

    it('does not carry one caller\'s conversation into another\'s', async () => {
      await service(new ScriptedModel(() => say('Fine.'))).ask(body({ event_id: alertId }), env);
      const model = new ScriptedModel(() => say('You have one machine.'));
      await service(model).ask(body({ caller_phone: '+12025550111', question: 'And its fuel?' }), env);
      expect(lastQuestion(model)).not.toContain('DG-01');
      expect(model.seen[0].turns).toHaveLength(1);
    });

    it('refuses a number nobody on the account has, without asking the model', async () => {
      const model = new ScriptedModel(() => say('should not be asked'));
      const out = await service(model).ask(body({ caller_phone: '+15550000000' }), env);
      expect(out).toEqual({ conversation_id: 'conv-1', status: 'refused', reason: 'unknown_caller', answer: REFUSALS.unknown_caller });
      expect(model.seen).toEqual([]);
      expect((await turns())[0]).toMatchObject({ user_id: null, status: 'refused', reason: 'unknown_caller' });
    });

    it('refuses somebody whose invitation is not accepted, as the app would', async () => {
      const model = new ScriptedModel(() => say('should not be asked'));
      const out = await service(model).ask(body({ caller_phone: '+12025550199' }), env);
      expect(out.reason).toBe('caller_not_active');
      expect(model.seen).toEqual([]);
    });
  });

  describe('which machines', () => {
    it('refuses a machine the caller is not assigned to, before any lookup', async () => {
      const model = new ScriptedModel(() => say('should not be asked'));
      const out = await service(model).ask(body({ caller_phone: '+12025550111', machine_id: 'dg-01' }), env);
      expect(out).toMatchObject({ status: 'refused', reason: 'not_your_machine', answer: REFUSALS.not_your_machine });
      expect(model.seen).toEqual([]);
    });

    it('refuses the alert\'s machine too, when the caller is not assigned to it', async () => {
      const out = await service(new ScriptedModel(() => say('no'))).ask(
        body({ caller_phone: '+12025550111', event_id: alertId }), env);
      expect(out.reason).toBe('not_your_machine');
    });

    it('answers about a machine the caller names, when it is theirs', async () => {
      const model = new ScriptedModel(() => say('Diesel Generator DG-02 has no open alerts.'));
      const out = await service(model).ask(
        body({ caller_phone: '+12025550111', question: 'How is diesel generator DG-02 doing?' }), env);
      expect(out).toMatchObject({ status: 'answered', machine: { machine_id: 'dg-02', name: 'Diesel Generator DG-02' } });
    });

    it('runs every lookup as the caller, so another machine never reaches the answer', async () => {
      // list_alerts narrows to the caller's machines itself.
      await owner.query(
        `INSERT INTO alert_event (tenant_id, rule_id, rule_name, source_system, external_id, severity, summary, evidence, state, fired_at)
           VALUES ('usa-test', gen_random_uuid(), 'Low fuel', $1, 'DG-02', 'medium', 'fuel low', '{}'::jsonb, 'open', now())`, [SRC]);
      const model = new ScriptedModel((_, n) => (n === 0 ? call('list_alerts') : say('One alert: low fuel on DG-02.')));
      await service(model).ask(body({ caller_phone: '+12025550111', question: 'Any alerts on my machines?' }), env);
      const seen = JSON.stringify(model.seen[1].turns[model.seen[1].turns.length - 1]);
      expect(seen).toContain('Low fuel');
      expect(seen).not.toContain('Main bearing vibration rising');
      await owner.query(`DELETE FROM alert_event WHERE rule_name = 'Low fuel'`);
    });

    it('withholds a tool that would list machines the caller is not assigned to', async () => {
      // list_equipment reads every machine in the account (EquipmentService.list
      // ignores the caller's assignment), so a limited caller is not offered it — and
      // if the model calls it anyway, it is refused rather than run.
      const model = new ScriptedModel((_, n) => (n === 0 ? call('list_equipment') : say('I cannot list them.')));
      await service(model).ask(body({ caller_phone: '+12025550111', question: 'What machines do I have?' }), env);
      expect(model.seen[0].tools.map((t) => t.name)).not.toContain('list_equipment');
      const seen = JSON.stringify(model.seen[1].turns[model.seen[1].turns.length - 1]);
      expect(seen).toContain('No tool \\"list_equipment\\" is available.');
      expect(seen).not.toContain('DG-01');
    });

    it('still offers it to a caller who sees the whole account', async () => {
      const model = new ScriptedModel(() => say('You have two machines.'));
      await service(model).ask(body({ question: 'What machines do I have?' }), env);
      expect(model.seen[0].tools.map((t) => t.name)).toContain('list_equipment');
    });

    it('refuses a machine Vani names that this account does not have', async () => {
      const out = await service(new ScriptedModel(() => say('no'))).ask(body({ machine_id: 'gx-9' }), env);
      expect(out.reason).toBe('unknown_machine');
    });
  });

  describe('when the analysis cannot answer', () => {
    it('says the day\'s allowance is spent', async () => {
      const out = await service(new ScriptedModel(() => say('no')), 0).ask(body(), env);
      expect(out).toMatchObject({ status: 'refused', reason: 'budget_exhausted', answer: REFUSALS.budget_exhausted });
    });

    it('says it cannot look it up just now when the model fails, and never guesses', async () => {
      const model = new ScriptedModel(() => { throw new Error('model timed out'); });
      const out = await service(model).ask(body({ event_id: alertId }), env);
      expect(out).toMatchObject({ status: 'refused', reason: 'assistant_unavailable', machine: { machine_id: 'dg-01' } });
    });

    it('says so when it runs out of steps', async () => {
      const model = new ScriptedModel(() => call('list_alerts'));
      const out = await service(model).ask(body(), env);
      expect(out.reason).toBe('incomplete');
    });

    it('is off until it is switched on', async () => {
      await expect(service(null).ask(body(), {})).rejects.toThrow(/VANI_ASK_ENABLED/);
    });
  });

  describe('the turn log', () => {
    it('refuses an answer recorded for nobody, and a refusal with no reason', async () => {
      const insert = (over: Record<string, unknown>) => owner.query(
        `INSERT INTO vani_conversation_turn (tenant_id, conversation_id, caller_phone, question, answer, status, reason, user_id)
           VALUES ('usa-test', 'c', '+1', 'q', 'a', $1, $2, $3)`,
        [over.status, over.reason ?? null, over.user_id ?? null]);
      await expect(insert({ status: 'answered' })).rejects.toThrow(/ck_vani_turn_answered_user/);
      await expect(insert({ status: 'refused' })).rejects.toThrow(/ck_vani_turn_reason/);
    });

    it('cannot be rewritten by the service', async () => {
      await service(new ScriptedModel(() => say('Fine.'))).ask(body(), env);
      await expect(ds.transaction(async (m) => {
        await m.query(`SELECT set_config('ta.tenant_id', 'usa-test', true)`);
        await m.query(`UPDATE vani_conversation_turn SET answer = 'something else'`);
      })).rejects.toThrow(/permission denied/);
    });
  });

  describe('over HTTP', () => {
    const post = (b: unknown, secret: string | null = 'shared-with-vani') => {
      const r = request(app.getHttpServer()).post('/api/v1/vani/ask');
      return (secret === null ? r : r.set('X-Vani-Secret', secret)).send(b as object);
    };

    beforeEach(() => { process.env.VANI_CALLBACK_SECRET = 'shared-with-vani'; process.env.VANI_ASK_ENABLED = 'true'; });
    afterEach(() => { delete process.env.VANI_ASK_ENABLED; });

    it('refuses a missing or wrong secret, and is off without the switch', async () => {
      expect((await post(body(), null)).status).toBe(401);
      expect((await post(body(), 'guess')).status).toBe(401);
      delete process.env.VANI_ASK_ENABLED;
      expect((await post(body())).status).toBe(503);
    });

    it('refuses a malformed question and an unknown account', async () => {
      expect((await post(body({ caller_phone: '201-203-1340' }))).status).toBe(400);
      expect((await post(body({ question: 'x'.repeat(501) }))).status).toBe(400);
      expect((await post(body({ account_id: 'nobody' }))).status).toBe(404);
    });

    it('answers in words even when no model is configured on this server', async () => {
      const res = await post(body());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'refused', reason: 'assistant_unavailable', answer: REFUSALS.assistant_unavailable });
    });
  });
});
