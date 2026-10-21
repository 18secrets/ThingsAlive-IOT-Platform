import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** `docs/ai/contracts/forecast/forecast-request.v1.schema.json`. */
export interface ForecastRequest {
  contract: 'forecast-request.v1';
  model: { key: string; revision: string };
  contextLength: number;
  predictionLength: number;
  series: { id: string; stepSeconds: number; start: string; values: number[] }[];
}

/** `docs/ai/contracts/forecast/forecast-response.v1.schema.json`. */
export interface ForecastResponse {
  contract: 'forecast-response.v1';
  model: { key: string; revision: string; weightsSha256: string };
  series: { id: string; values: number[] }[];
  refused: { id: string; reason: string }[];
  timing: { loadSeconds: number; inferSeconds: number };
}

export interface WorkerCommand {
  command: string;
  args: string[];
  /** Extra environment for the child; the parent's is not passed on except PATH and HOME. */
  env?: Record<string, string>;
}

export const FORECAST_WORKER = Symbol('ta:forecast-worker');

/** A worker that failed, said something unreadable, or answered a different question. */
export class ForecastWorkerError extends Error {}

/**
 * Where the Python worker is, from the environment: the image sets FORECAST_PYTHON to its
 * venv, and the script ships beside `dist/` (Dockerfile.scheduler). Overridable whole, so
 * the tests can speak the same contract through a stub with no `torch` anywhere.
 */
export function workerCommandFromEnv(env: Record<string, string | undefined>): WorkerCommand {
  const python = env.FORECAST_PYTHON?.trim() || 'python3';
  const script = env.FORECAST_WORKER_SCRIPT?.trim() || join(__dirname, '..', '..', 'python', 'forecast', 'infer.py');
  return { command: python, args: ['-I', script] };
}

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/**
 * One request, one child, one answer (QML1 §1). The child gets the series on stdin and
 * nothing else: no database, no tenant, no credentials — its environment is rebuilt
 * from a short allowlist rather than inherited, so a DB_PASSWORD in the scheduler's
 * environment never reaches it. It exits when stdin closes; a non-zero exit, a timeout
 * or an answer that fails `validateResponse` is an error, and the caller writes nothing.
 */
export function runWorker(cmd: WorkerCommand, request: ForecastRequest, timeoutMs: number): Promise<ForecastResponse> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'LANG', 'HF_HUB_OFFLINE', 'TTM_MODEL_DIR', 'TTM_MODEL_NAME', 'TTM_REVISION', 'OMP_NUM_THREADS']) {
      if (process.env[k] !== undefined) env[k] = process.env[k]!;
    }
    const child = spawn(cmd.command, cmd.args, { env: { ...env, ...(cmd.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new ForecastWorkerError(message));
    };
    const timer = setTimeout(() => fail(`worker did not answer within ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      outBytes += b.length;
      if (outBytes > MAX_STDOUT_BYTES) return fail('worker answer exceeded the size limit');
      out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-4000); });
    child.on('error', (e) => fail(`worker could not start: ${e.message}`));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new ForecastWorkerError(`worker exited ${code}: ${err.trim().split('\n').pop() ?? ''}`.trim()));
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(out).toString('utf8'));
      } catch {
        return reject(new ForecastWorkerError('worker answer is not JSON'));
      }
      try {
        resolve(validateResponse(request, parsed));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(request));
  });
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The response checked against the contract before anything is written (QML1 §1). Every
 * series asked about is answered exactly once — forecast or refused — with exactly
 * `predictionLength` finite numbers; the model it echoes is the one asked for. A response
 * that fails any of it fails the pass whole: a forecast is never written in part.
 */
export function validateResponse(request: ForecastRequest, raw: unknown): ForecastResponse {
  const bad = (why: string): never => { throw new ForecastWorkerError(`worker answer refused: ${why}`); };
  if (!raw || typeof raw !== 'object') bad('not an object');
  const r = raw as Record<string, unknown>;
  if (r.contract !== 'forecast-response.v1') bad(`contract ${String(r.contract)}`);
  const model = r.model as Record<string, unknown> | undefined;
  if (!model || model.key !== request.model.key || model.revision !== request.model.revision) {
    bad(`model ${String(model?.key)}@${String(model?.revision)} is not ${request.model.key}@${request.model.revision}`);
  }
  if (typeof model!.weightsSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(model!.weightsSha256 as string)) bad('weightsSha256');
  if (!Array.isArray(r.series) || !Array.isArray(r.refused)) bad('series/refused');
  const timing = r.timing as Record<string, unknown> | undefined;
  if (!timing || !isNum(timing.loadSeconds) || !isNum(timing.inferSeconds)) bad('timing');

  const asked = new Set(request.series.map((s) => s.id));
  const answered = new Set<string>();
  for (const s of r.series as Record<string, unknown>[]) {
    const id = s?.id as string;
    if (typeof id !== 'string' || !asked.has(id) || answered.has(id)) bad(`series id ${String(id)}`);
    const values = s.values as unknown[];
    if (!Array.isArray(values) || values.length !== request.predictionLength) bad(`series ${id} has ${Array.isArray(values) ? values.length : 'no'} values`);
    if (!values.every(isNum)) bad(`series ${id} has a non-finite value`);
    answered.add(id);
  }
  for (const s of r.refused as Record<string, unknown>[]) {
    const id = s?.id as string;
    if (typeof id !== 'string' || !asked.has(id) || answered.has(id) || typeof s.reason !== 'string') bad(`refused ${String(id)}`);
    answered.add(id);
  }
  if (answered.size !== asked.size) bad(`${asked.size - answered.size} series unanswered`);
  return raw as ForecastResponse;
}
