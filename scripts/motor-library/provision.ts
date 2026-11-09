/**
 * Loads the motor library into a running platform, through its own API, and sets up the
 * POC machine in the motors account so the motor logger simulator (or the real logger)
 * has somewhere to land.
 *
 *   npx ts-node scripts/motor-library/provision.ts --url https://<api-host> \
 *     --master-token <Master Admin bearer> --tenant-token <motors super admin bearer>
 *
 *   MASTER_TOKEN / TENANT_TOKEN in the environment work in place of the flags.
 *   TENANT_EMAIL + TENANT_PASSWORD instead of a tenant token: signs in as the motors super
 *   admin through /api/v1/auth/sign-in (a real session, so the account's own role rows apply).
 *   --local-secret <AUTH_JWT_SECRET> --local-issuer <AUTH_JWT_ISSUER> mints the Master
 *   Admin token for a local stack (never point this at a shared environment).
 *   --create-tenant also creates the motors account and accepts its super admin's
 *   invitation, with TENANT_PASSWORD or a generated one (local only; the account exists
 *   on Development).
 *   --machine CODE --machine-name NAME --device ID: another motor and its logger (defaults:
 *   the POC machine POC-MINI-01 and MOTOR_001). Run once per motor; the library steps
 *   find their work already done and skip it.
 *
 * Every step checks what is already there first, so running it twice changes nothing
 * the second time. It needs the platform at the D56-D59 stack plus motor-ingest
 * (MRs !228, !230-!234): ratings, models, duty curves, rated alert bounds, the logger.
 *
 * Master Admin (platform) steps: import the two classes from the template workbook,
 * publish them, create and publish the rated alert templates, create the Crompton Mini
 * 1 HP model with its ratings, grant both classes to the account, register the logger
 * and assign it to the account, issue its key.
 * Account (motors super admin) steps: copy the model, add the POC machine, name its
 * model, give it the day/night shifts, claim the logger onto it, bind its signals.
 */
import { Workbook } from 'exceljs';
import {
  ALERT_TEMPLATES, CLASSES, FAILURE_MODES, FORMULAS, LAYOUT, MINI_1HP_MODEL, POC, SIGNALS,
} from './content';

type Json = Record<string, any>;

function arg(name: string, argv = process.argv.slice(2)): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

class Api {
  constructor(private readonly base: string, private readonly token: string, private readonly who: string) {}

  async call(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; body: any }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* binary or plain text */ }
    if (res.status >= 400 && !okStatuses.includes(res.status)) {
      throw new Error(`${this.who} ${method} ${path} → ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }
    return { status: res.status, body: parsed };
  }

  get = (p: string, ok?: number[]) => this.call('GET', p, undefined, ok);
  post = (p: string, b?: unknown, ok?: number[]) => this.call('POST', p, b ?? {}, ok);
  put = (p: string, b: unknown, ok?: number[]) => this.call('PUT', p, b, ok);

  async download(path: string): Promise<Buffer> {
    const res = await fetch(`${this.base}${path}`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`${this.who} GET ${path} → ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

const step = (msg: string) => console.log(`• ${msg}`);

/** Fills the platform's own template: its headers are the contract (QIMP1). */
async function buildWorkbook(template: Buffer): Promise<Buffer> {
  const wb = new Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(template as any);
  const sheet = (name: string) => wb.getWorksheet(name)!;
  const headers = (name: string) => (sheet(name).getRow(1).values as unknown[]).slice(1).map(String);
  const clear = (name: string) => { const ws = sheet(name); for (let r = ws.rowCount; r >= 2; r -= 1) ws.spliceRows(r, 1); };
  const add = (name: string, row: Json) => sheet(name).addRow(headers(name).map((h) => row[h] ?? null));

  for (const name of ['equipment_class', 'signal', 'failure_mode', 'recommendation', 'layout', 'sensor_capability', 'formula']) clear(name);
  sheet('_meta').getRow(2).getCell(3).value = 'Things Alive motor library (scripts/motor-library)';

  for (const c of CLASSES) add('equipment_class', { slug: c.slug, name: c.name, description: c.description, category: c.category });
  for (const c of CLASSES) {
    for (const s of SIGNALS) {
      add('signal', { class_slug: c.slug, signal: s.signal, unit: s.unit, required: s.required ? 'TRUE' : 'FALSE', description: s.description });
    }
    for (const f of FORMULAS.filter((x) => x.classes.includes(c.slug))) {
      add('formula', {
        class_slug: c.slug, formula_key: f.key, kind: f.kind ?? 'physics', expression: f.expression, inputs: f.inputs.join(', '), output_unit: f.unit,
        basis: `${f.useCase}: ${f.basis}`, references: '[]', aggregation_window: f.window, chart_type: f.chart,
        ...(f.target ? { target_value: f.target.value, target_direction: f.target.direction } : {}),
      });
    }
    LAYOUT.filter((w) => w.classes.includes(c.slug)).forEach((w, i) => add('layout', {
      class_slug: c.slug, widget_key: w.key, widget_type: w.type, bound_to: w.boundTo, title: w.title, position: i + 1, size: w.size,
    }));
    for (const m of FAILURE_MODES.filter((x) => x.classes.includes(c.slug))) {
      add('failure_mode', { class_slug: c.slug, code: m.code, name: m.name, symptom: m.symptom, severity: m.severity, signals: m.signals.join(', ') });
      add('recommendation', { class_slug: c.slug, failure_mode_code: m.code, action: m.action, urgency: m.urgency });
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function platformSteps(master: Api, deviceId: string): Promise<{ masterModelId: string }> {
  const existing: Json[] = (await master.get('/api/v1/catalog/authoring/equipment-classes')).body;
  const published = (slug: string) => existing.some((c) => c.slug === slug && c.status === 'published');

  if (CLASSES.every((c) => published(c.slug))) {
    step('Classes already published; import skipped.');
  } else {
    const workbook = await buildWorkbook(await master.download('/api/v1/platform/catalog/template'));
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(workbook)]), 'motor-library.xlsx');
    const { body: batch } = await master.post('/api/v1/platform/catalog/imports', form);
    const { body: diff } = await master.get(`/api/v1/platform/catalog/imports/${batch.id}`);
    // Anything but a valid row would be left out of the catalog without failing the apply.
    const refused = JSON.stringify(diff).match(/"status":"(invalid|skipped)"/g)?.length ?? 0;
    if (refused) throw new Error(`The workbook has ${refused} refused row(s): ${JSON.stringify(diff).slice(0, 3000)}`);
    await master.post(`/api/v1/platform/catalog/imports/${batch.id}/apply`, { acknowledgeWarnings: true });
    step(`Imported ${CLASSES.length} classes (batch ${batch.id}).`);
    for (const c of CLASSES) {
      await master.post(`/api/v1/catalog/equipment-classes/${c.slug}/publish`, { acknowledgeWarnings: true });
      step(`Published class ${c.slug}.`);
    }
  }

  const templates: Json[] = (await master.get('/api/v1/catalog/authoring/alert-templates')).body;
  for (const c of CLASSES) {
    for (const a of ALERT_TEMPLATES) {
      const slug = `${c.slug}-${a.slugSuffix}`;
      const found = templates.find((t) => t.slug === slug);
      if (!found) {
        await master.post('/api/v1/catalog/alert-templates', {
          slug, equipmentClassSlug: c.slug, name: a.name, trigger: 'signal-threshold', params: a.params, severity: a.severity,
          description: a.params.rating
            ? 'Bound is a multiple of each machine\'s own rating (D59), from its nameplate or its model.'
            : 'From the motor logger contract.',
        });
      }
      if (!found || found.status !== 'published') {
        await master.post(`/api/v1/catalog/alert-templates/${slug}/publish`);
        step(`Alert template ${slug} published.`);
      }
    }
  }

  const models: Json[] = (await master.get('/api/v1/equipment-templates')).body;
  let model = models.find((t) => t.name === MINI_1HP_MODEL.name);
  if (!model) {
    model = (await master.post('/api/v1/equipment-templates', {
      name: MINI_1HP_MODEL.name, manufacturer: MINI_1HP_MODEL.manufacturer, category: MINI_1HP_MODEL.category,
      description: MINI_1HP_MODEL.description, equipmentClassSlug: MINI_1HP_MODEL.equipmentClassSlug,
    })).body;
    step(`Model "${MINI_1HP_MODEL.name}" created.`);
  }
  await master.put(`/api/v1/equipment-templates/${model.id}/ratings`, { ratings: MINI_1HP_MODEL.ratings });
  step(`Model ratings set: ${MINI_1HP_MODEL.ratings.map((r) => r.name).join(', ')}.`);

  const grants: Json[] = (await master.get('/api/v1/catalog/entitlements')).body;
  for (const c of CLASSES) {
    if (grants.some((g) => g.tenantId === POC.tenantId && g.equipmentClassSlug === c.slug && !g.revokedAt)) continue;
    await master.post('/api/v1/catalog/entitlements', { tenantId: POC.tenantId, equipmentClassSlug: c.slug, note: 'Motor library (Crompton POC)' });
    step(`Granted ${c.slug} to ${POC.tenantId}.`);
  }

  const pool: Json[] = (await master.get('/api/v1/inventory/pool')).body?.devices ?? (await master.get('/api/v1/inventory/pool')).body;
  const device = (Array.isArray(pool) ? pool : []).find((d) => d.imei === deviceId);
  if (!device) {
    await master.post('/api/v1/inventory/register', { devices: [{ imei: deviceId, model: 'SIM800L motor logger', notes: 'Crompton POC logger' }] });
    step(`Logger ${deviceId} registered.`);
  }
  if (!device || device.state !== 'assigned') {
    await master.post('/api/v1/inventory/assign', { imeis: [deviceId], tenantId: POC.tenantId });
    step(`Logger ${deviceId} assigned to ${POC.tenantId}.`);
  }
  return { masterModelId: model.id };
}

interface Target { machineCode: string; machineName: string; deviceId: string }

async function accountSteps(account: Api, masterModelId: string, t: Target): Promise<void> {
  const mine: Json[] = (await account.get('/api/v1/my-equipment-templates')).body;
  let model = mine.find((t) => t.copiedFromId === masterModelId);
  if (!model) {
    model = (await account.post(`/api/v1/my-equipment-templates/from/${masterModelId}`, {})).body;
    step(`Account copy of the model made (ratings with it).`);
  }

  const ref = `ta-2.0/${t.machineCode}`;
  const machines: Json[] = (await account.get('/api/v1/equipment')).body;
  if (!machines.some((m) => m.externalId === t.machineCode)) {
    await account.post('/api/v1/equipment', { code: t.machineCode, name: t.machineName, equipmentClassSlug: MINI_1HP_MODEL.equipmentClassSlug });
    step(`Machine ${t.machineCode} added.`);
  }
  await account.put(`/api/v1/equipment/${ref}/model`, { modelId: model.id });
  step(`Machine ${t.machineCode} reads its ratings from "${model.name}".`);
  await account.post(`/api/v1/equipment/${ref}/shifts/from-template`, { templateSlug: POC.shiftTemplate });
  step(`Shifts: ${POC.shiftTemplate}.`);

  const claimed = await account.post('/api/v1/inventory/claim', { imei: t.deviceId, equipmentExternalId: t.machineCode, sourceSystem: 'ta-2.0' }, [409]);
  step(claimed.status === 409 ? `Logger ${t.deviceId} already on the machine.` : `Logger ${t.deviceId} claimed onto ${t.machineCode}.`);

  const validFrom = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
  for (const s of SIGNALS) {
    const r = await account.post(`/api/v1/equipment/${ref}/bindings`, {
      action: 'activate', signalKey: s.signal, measurementRole: s.signal, origin: 'physical', imei: t.deviceId, channel: s.signal,
      canonicalUnit: s.unit, validFrom, discoveredBy: 'manual', expectedPeriodSeconds: 60,
    }, [409]);
    if (r.status !== 409) step(`Bound ${s.signal} (${s.unit}) to ${t.deviceId}.`);
  }
}

async function main(): Promise<number> {
  const url = (arg('url') ?? 'http://localhost:3000').replace(/\/+$/, '');
  let masterToken = arg('master-token') ?? process.env.MASTER_TOKEN ?? '';
  let tenantToken = arg('tenant-token') ?? process.env.TENANT_TOKEN ?? '';
  const secret = arg('local-secret');
  if (secret) {
    const issuer = arg('local-issuer') ?? 'things-alive';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mintPlatformToken } = require('../../src/platform/platform-token');
    masterToken = mintPlatformToken({ role: 'master-admin', subject: 'provision@things-alive.io' }, { secret, issuer }).token;
  }
  if (!masterToken) {
    console.error('Need --master-token (or MASTER_TOKEN), or --local-secret for a local stack.');
    return 1;
  }
  const master = new Api(url, masterToken, 'Master Admin');

  if (process.argv.includes('--create-tenant')) {
    // The account's super admin signs in for real: an account's role rows (D03) reach a
    // request only through its own session, never through claims minted here.
    const r = await master.post('/api/v1/accounts', {
      tenantId: POC.tenantId, name: 'Motors', superAdmin: { email: `poc+${POC.tenantId}@things-alive.local`, fullName: 'POC admin' },
    }, [409]);
    const invitation = r.body?.invitationToken
      // Re-sending is refused once the invitation was accepted: then the admin signs in below.
      ?? (await master.post(`/api/v1/accounts/${POC.tenantId}/resend-invitation`, {}, [400, 409])).body?.invitationToken;
    step(r.status === 409 || r.body?.alreadyExisted ? 'Account motors already exists.' : 'Account motors created.');
    if (invitation) {
      const password = process.env.TENANT_PASSWORD || `Poc!${require('crypto').randomBytes(9).toString('base64url')}9a`;
      tenantToken = (await new Api(url, '', 'invitation').post('/api/v1/auth/accept-invitation', { token: invitation, password })).body.accessToken;
      step('Super admin invitation accepted (local password, not printed).');
    }
  }
  const email = process.env.TENANT_EMAIL
    ?? (process.argv.includes('--create-tenant') ? `poc+${POC.tenantId}@things-alive.local` : undefined);
  if (!tenantToken && email && process.env.TENANT_PASSWORD) {
    tenantToken = (await new Api(url, '', 'sign-in').post('/api/v1/auth/sign-in', {
      email, password: process.env.TENANT_PASSWORD,
    })).body.accessToken;
    step(`Signed in as ${email}.`);
  }
  if (!tenantToken) {
    console.error('Need the motors super admin: --tenant-token / TENANT_TOKEN, or TENANT_EMAIL + TENANT_PASSWORD.');
    return 1;
  }
  const account = new Api(url, tenantToken, POC.tenantId);

  const target: Target = {
    machineCode: arg('machine') ?? POC.machineCode,
    machineName: arg('machine-name') ?? (arg('machine') ? `${arg('machine')} (Mini 1 HP)` : POC.machineName),
    deviceId: arg('device') ?? POC.deviceId,
  };
  console.log(`Provisioning the motor library on ${url}`);
  const { masterModelId } = await platformSteps(master, target.deviceId);
  await accountSteps(account, masterModelId, target);
  const key = (await master.post(`/api/v1/motor-loggers/${target.deviceId}/key`)).body.key;
  console.log(`\nDone. Logger ${target.deviceId} key (shown once; replaces any earlier key):\n  ${key}`);
  console.log(`Send data: npm run motor:sim -- --url ${url} --device ${target.deviceId} --key ${key} --scenario normal --backfill 30`);
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e: Error) => { console.error(e.message); process.exit(1); });
}
