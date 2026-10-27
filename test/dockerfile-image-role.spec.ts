import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (name: string) => readFileSync(join(ROOT, name), 'utf8');

/** Each `FROM … AS name` stage's text, up to the next FROM. */
function stages(dockerfile: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = dockerfile.split(/^(?=FROM )/m).filter((p) => p.startsWith('FROM '));
  for (const part of parts) {
    const name = part.match(/^FROM \S+ AS (\S+)/)?.[1];
    if (name) out.set(name, part);
  }
  return out;
}

/**
 * One Dockerfile, two images (D46 still holds: the api never carries Python).
 *
 * Railway's builder stopped honouring the scheduler's Dockerfile Path on 2026-10-26: it
 * built the root Dockerfile whatever the setting said, so the scheduler shipped without
 * Python and every forecast pass failed with `spawn python3 ENOENT`, silently, for a day.
 * The image is now chosen by IMAGE_ROLE, a build argument the scheduler service sets, and
 * Dockerfile.scheduler is the same file defaulting to the scheduler — so the scheduler
 * gets its image whichever of the two the builder reads.
 *
 * Everything here is about the file, not a build: what would go wrong is a second copy
 * drifting, or the api's stage picking up the forecaster, and neither fails a build.
 */
describe('the image role switch', () => {
  const dockerfile = read('Dockerfile');
  const scheduler = read('Dockerfile.scheduler');
  const byName = stages(dockerfile);

  it('keeps Dockerfile.scheduler identical to Dockerfile except for the default role', () => {
    // A second copy that drifts is the scheduler shipping last month's forecaster from
    // one path and this month's from the other, with nothing to say which.
    expect(dockerfile).toMatch(/^ARG IMAGE_ROLE=api$/m);
    expect(scheduler).toMatch(/^ARG IMAGE_ROLE=scheduler$/m);
    expect(scheduler.replace(/^ARG IMAGE_ROLE=scheduler$/m, 'ARG IMAGE_ROLE=api')).toBe(dockerfile);
  });

  it('declares the role before the first FROM, and builds the stage it names last', () => {
    // A FROM can only read an ARG declared above every stage. Declared inside one, the
    // final FROM sees an empty value and the build fails on a stage called "".
    const firstFrom = dockerfile.search(/^FROM /m);
    expect(dockerfile.search(/^ARG IMAGE_ROLE=/m)).toBeLessThan(firstFrom);
    const froms = dockerfile.match(/^FROM .*$/gm) ?? [];
    expect(froms[froms.length - 1]).toBe('FROM ${IMAGE_ROLE}');
    expect([...byName.keys()]).toEqual(expect.arrayContaining(['api', 'scheduler']));
  });

  it('gives the api stage no Python, torch or forecaster (D46)', () => {
    const api = byName.get('api')!;
    for (const forbidden of ['python3', 'venv', 'pip ', 'requirements.txt', 'TTM_', 'infer.py']) {
      expect(api).not.toContain(forbidden);
    }
    // And it keeps the library-search model the scheduler does without (QEMB1).
    expect(api).toContain('COPY --from=model /models /app/models');
  });

  it('gives the scheduler stage the forecaster, pinned, and runs it as node', () => {
    const stage = byName.get('scheduler')!;
    expect(stage).toContain('python3 python3-venv');
    expect(stage).toContain('--require-hashes -r /opt/forecast-requirements.txt');
    expect(stage).toContain('FORECAST_PYTHON=/opt/venv/bin/python');
    expect(stage).toContain('COPY python/forecast/infer.py');
    expect(stage).toMatch(/^USER node$/m);
    // The revision fetched and the revision the worker reports must be the same value,
    // or the pass refuses the model it was built with (QML1 §2).
    const fetched = stage.match(/^ARG TTM_REVISION=(\w+)$/m)?.[1];
    const reported = stage.match(/TTM_REVISION=(\w+) \\$/m)?.[1];
    expect(fetched).toBeDefined();
    expect(reported).toBe(fetched);
    expect(stage).not.toContain('--from=model');
  });
});
