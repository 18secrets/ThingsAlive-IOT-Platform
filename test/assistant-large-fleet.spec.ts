import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GeminiModel, isOverloaded } from '../src/assistant/assistant-model';
import { AssistantTools, bound, LIST_IN_FULL } from '../src/assistant/assistant-tools';
import { RequestScope } from '../src/auth/types/request-scope';
import { createApp } from '../src/main';
import { createTestDataSource, describeDb } from './db';

/**
 * Ask AI on a real-sized fleet, and on a busy model (Dev, 5 Nov: 40 questions asked).
 *
 * Two things went wrong there. 19 questions got "could not answer" because Gemini said
 * it was busy and Dev's model is its own fallback, so nothing asked again. And the
 * demo account's 85 machines were cut to fit one tool result, so the model counted
 * what was left: "43 machines", "3 sites" of 6, "no excavators" with 25 of them.
 */

describe('a busy model is asked again', () => {
  const FLASH_LITE = 'gemini-3.5-flash-lite';
  const ok = { candidates: [{ content: { parts: [{ text: 'Fine.' }] } }], usageMetadata: { totalTokenCount: 5 } };
  const busy = Object.assign(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'), { status: 503 });
  const input = { system: 's', turns: [{ role: 'user' as const, text: 'q' }], tools: [] };

  /** A Gemini that answers from a script, and remembers which model each call asked. */
  const scripted = (primary: string, replies: unknown[]) => {
    const model = new GeminiModel({ mode: 'api-key', apiKey: 'unused', model: primary }, [0, 0]);
    const asked: string[] = [];
    (model as unknown as { ai: unknown }).ai = {
      models: {
        generateContent: async (req: { model: string }) => {
          asked.push(req.model);
          const next = replies.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    };
    return { model, asked };
  };

  it('asks the same model again when it is its own fallback, which is how Dev runs', async () => {
    const { model, asked } = scripted(FLASH_LITE, [busy, busy, ok]);
    await expect(model.generate(input)).resolves.toMatchObject({ text: 'Fine.' });
    expect(asked).toEqual([FLASH_LITE, FLASH_LITE, FLASH_LITE]);
  });

  it('gives up after the waits run out, with the model\'s own error', async () => {
    const { model, asked } = scripted(FLASH_LITE, [busy, busy, busy, ok]);
    await expect(model.generate(input)).rejects.toThrow(/high demand/);
    expect(asked).toHaveLength(3);
  });

  it('does not ask again when the request itself was refused', async () => {
    const bad = Object.assign(new Error('Request contains an invalid argument.'), { status: 400 });
    const { model, asked } = scripted(FLASH_LITE, [bad, ok]);
    await expect(model.generate(input)).rejects.toThrow(/invalid argument/);
    expect(asked).toEqual([FLASH_LITE]);
  });

  it('moves a busy primary to the fallback, and asks the fallback again if it is busy too', async () => {
    const { model, asked } = scripted('gemini-x-pro', [busy, busy, ok]);
    await expect(model.generate(input)).resolves.toMatchObject({ text: 'Fine.' });
    expect(asked).toEqual(['gemini-x-pro', FLASH_LITE, FLASH_LITE]);
  });

  it('tells busy from refused', () => {
    expect(isOverloaded(busy)).toBe(true);
    expect(isOverloaded({ status: 429, message: 'RESOURCE_EXHAUSTED' })).toBe(true);
    expect(isOverloaded({ status: 400, message: 'invalid argument' })).toBe(false);
    expect(isOverloaded({ status: 404, message: 'model not found' })).toBe(false);
  });
});

describe('a result too large to send whole', () => {
  it('says plainly that it is incomplete and must not be counted', () => {
    const out = bound({ rows: Array.from({ length: 40 }, (_, i) => ({ i, pad: 'x'.repeat(400) })) }) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
    expect(out.note).toMatch(/INCOMPLETE/);
    expect(out.note).toMatch(/Do not count/);
  });
});

describeDb('list_equipment on a fleet larger than one result', () => {
  let owner: DataSource;
  let app: INestApplication;
  let tools: AssistantTools;
  const ids: Record<string, string> = {};
  const admin: RequestScope = { tenantId: 'bigco', userId: 'u-admin', roles: ['admin'], isPlatformRole: false };

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    process.env.AUTH_JWT_SECRET = 'test-secret-large-fleet';
    process.env.AUTH_JWT_ISSUER = 'things-alive-large-fleet-test';
    process.env.AUTH_TENANT_CLAIM = 'client_id';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    for (const k of ['ASSISTANT_VERTEX_PROJECT', 'ASSISTANT_VERTEX_LOCATION', 'ASSISTANT_MODEL', 'ASSISTANT_GEMINI_API_KEY']) {
      delete process.env[k];
    }
    app = await createApp({ database: true });
    await app.init();
    tools = app.get(AssistantTools);

    await owner.query(`INSERT INTO tenant (tenant_id, name) VALUES ('bigco', 'Big Co'), ('other', 'Other Co')`);
    for (const [code, name] of [['NORTH', 'North yard'], ['SOUTH', 'South yard'], ['EMPTY', 'Empty yard']]) {
      const [p] = await owner.query(
        `INSERT INTO plant (tenant_id, code, name, status) VALUES ('bigco', $1, $2, 'active') RETURNING id`, [code, name]);
      ids[code] = p.id;
    }
    await owner.query(`INSERT INTO client_equipment_class (tenant_id, slug, name) VALUES
      ('bigco', 'hydraulic-excavator', 'Hydraulic excavator'), ('bigco', 'heavy-crawler-crane', 'Heavy crawler crane')`);
    // 25 excavators in the north and 20 cranes in the south: 45, more than are named in full.
    const machine = (code: string, slug: string, plant: string, name: string) => owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness, equipment_class_slug, plant_id)
         VALUES ('bigco', 'ta-2.0', $1, $2, 'client', 'active', 'basic', '{}'::jsonb, $3, $4)`, [code, name, slug, plant]);
    for (let i = 1; i <= 25; i++) await machine(`EX-${i}`, 'hydraulic-excavator', ids.NORTH, `Excavator ${i}`);
    for (let i = 1; i <= 20; i++) await machine(`CR-${i}`, 'heavy-crawler-crane', ids.SOUTH, `Crane ${i}`);
    await owner.query(
      `INSERT INTO equipment_profile (tenant_id, source_system, external_id, name, origin, status, tier, readiness)
         VALUES ('other', 'ta-2.0', 'X-1', 'Other Co secret rig', 'client', 'active', 'basic', '{}'::jsonb)`);
  }, 60_000);

  afterAll(async () => { await app?.close(); await owner?.destroy(); });

  it('counts every machine, type and site, even the empty one, and names only the first', async () => {
    const out = await tools.run(admin, 'list_equipment', {}) as Record<string, any>;
    expect(out.total).toBe(45);
    expect(out.byType).toEqual({ 'Hydraulic excavator': 25, 'Heavy crawler crane': 20 });
    expect(out.bySite).toEqual({ 'North yard': 25, 'South yard': 20, 'Empty yard': 0 });
    expect(out.machines).toHaveLength(LIST_IN_FULL);
    expect(out.note).toMatch(/All 45 machines are counted/);
    expect(JSON.stringify(out)).not.toContain('Other Co');
  });

  it('fits in one result whole, so the counts are never cut', async () => {
    const out = await tools.run(admin, 'list_equipment', {});
    expect(bound(out)).toEqual(out);
  });

  it('names every machine of a type when asked for that type', async () => {
    const cranes = await tools.run(admin, 'list_equipment', { type: 'crane' }) as Record<string, unknown>[];
    expect(cranes).toHaveLength(20);
    expect(cranes.every((c) => c.type === 'Heavy crawler crane')).toBe(true);
    const excavators = await tools.run(admin, 'list_equipment', { type: 'Excavator' }) as Record<string, unknown>[];
    expect(excavators).toHaveLength(25);
  });

  it('narrows by site name or code', async () => {
    expect(await tools.run(admin, 'list_equipment', { site: 'south' })).toHaveLength(20);
    expect(await tools.run(admin, 'list_equipment', { site: 'NORTH' })).toHaveLength(25);
    expect(await tools.run(admin, 'list_equipment', { site: 'Mumbai' })).toEqual([]);
  });

  it('does not tell a caller limited to some machines about sites beyond them', async () => {
    const operator: RequestScope = { ...admin, userId: 'u-op', roles: ['operator'], equipmentIds: ['CR-1'] };
    const out = await tools.run(operator, 'list_equipment', {});
    expect(JSON.stringify(out)).not.toContain('Empty yard');
  });

  it('does not name a site outside a site-limited caller\'s sites', async () => {
    const manager: RequestScope = { ...admin, userId: 'u-mgr', roles: ['manager'], plantIds: [ids.NORTH, ids.SOUTH] };
    const out = await tools.run(manager, 'list_equipment', {});
    expect(JSON.stringify(out)).not.toContain('Empty yard');
  });
});
