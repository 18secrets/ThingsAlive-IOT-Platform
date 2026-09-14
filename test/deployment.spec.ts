import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import { AppModule } from '../src/app.module';

const ROOT = join(__dirname, '..');
const read = (name: string) => readFileSync(join(ROOT, name), 'utf8');
const readJson = (name: string) => JSON.parse(read(name));

/**
 * The deployment configuration, checked against the application (task P5-01).
 *
 * Every assertion here is about a failure that produces no error message anywhere. A
 * healthcheck pointing at a route that does not exist does not crash: Railway holds
 * the new deployment at "unhealthy" until it times out and rolls back, for ever, and
 * the only symptom is that deploys stop working. A pre-deploy command naming a script
 * that was renamed fails the deploy with a line nobody reads until the third attempt.
 *
 * All of it is decidable without deploying anything, which is the point of checking it
 * here rather than finding out at the release.
 */
describe('deployment configuration', () => {
  const api = readJson('railway.json');
  const scheduler = readJson('railway.scheduler.json');
  const pkg = readJson('package.json');

  it('ships a Dockerfile, and both services build from it', () => {
    expect(existsSync(join(ROOT, 'Dockerfile'))).toBe(true);
    for (const config of [api, scheduler]) {
      expect(config.build.builder).toBe('DOCKERFILE');
      expect(config.build.dockerfilePath).toBe('Dockerfile');
    }
  });

  it('installs from the lockfile rather than resolving afresh', () => {
    // `npm install` in an image resolves whatever was newest that morning, so two
    // builds of the same commit a week apart can ship different dependency trees.
    //
    // Matched against the RUN lines rather than the whole file, so a comment that
    // mentions the thing it is warning against does not trip the check.
    const commands = read('Dockerfile').split('\n')
      .filter((line) => line.trimStart().startsWith('RUN ')).join('\n');
    expect(commands).toMatch(/npm ci/);
    expect(commands).not.toMatch(/npm install/);
    // And the runtime stage carries no build toolchain.
    expect(commands).toMatch(/npm ci --omit=dev/);
  });

  it('does not run as root', () => {
    expect(read('Dockerfile')).toMatch(/^USER node$/m);
  });

  it('runs migrations once, from one service, before traffic', () => {
    // Two services both migrating on deploy would race, and the second would find the
    // schema already moved. The api service owns it; the scheduler does not.
    expect(api.deploy.preDeployCommand).toBe('npm run migration:run');
    expect(scheduler.deploy.preDeployCommand).toBeUndefined();

    // And the script it names has to exist, or the deploy fails at the last moment
    // with a message nobody reads until the third attempt.
    const named = api.deploy.preDeployCommand.replace('npm run ', '');
    expect(pkg.scripts[named]).toBeDefined();
    // Against the compiled data source: the runtime image has no TypeScript.
    expect(pkg.scripts[named]).toMatch(/dist\/database\/data-source\.js/);
  });

  it('points its healthcheck at a route the application actually serves', async () => {
    /*
     * The assertion this file exists for.
     *
     * Rename the readiness route, or change the global prefix or the API version, and
     * nothing fails: the app starts, serves traffic locally, and passes every other
     * test. What breaks is deployment, silently and completely — Railway waits for a
     * 200 that never comes, times out, and keeps the old version. So the path is
     * checked against the live router rather than against a constant.
     */
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register({ database: false })],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();

    // Read from the live router the same way the auth matrix does, because the shape
    // of express's internals has moved between versions and a hard-coded path into
    // them is a test that silently stops checking anything.
    const instance: any = app.getHttpAdapter().getInstance();
    const stack = instance?.router?.stack ?? instance?._router?.stack ?? [];
    const routes: string[] = stack.filter((l: any) => l.route).map((l: any) => l.route.path);
    expect(routes.length).toBeGreaterThan(0);

    for (const config of [api, scheduler]) {
      expect(routes).toContain(config.deploy.healthcheckPath);
    }
    await app.close();
  });

  it('gives the healthcheck long enough to mean something', () => {
    // A readiness probe that checks the database needs more than a couple of seconds
    // on a cold start, and a timeout below that rejects healthy deployments.
    for (const config of [api, scheduler]) {
      expect(config.deploy.healthcheckTimeout).toBeGreaterThanOrEqual(15);
    }
  });

  it('restarts on failure, but not for ever', () => {
    // An unbounded restart loop on a bad release burns the platform's patience and
    // hides the failure behind a service that looks like it is starting.
    for (const config of [api, scheduler]) {
      expect(config.deploy.restartPolicyType).toBe('ON_FAILURE');
      expect(config.deploy.restartPolicyMaxRetries).toBeLessThanOrEqual(5);
    }
  });

  it('names every variable the application reads in the template', () => {
    /*
     * Derived rather than listed. A variable added in code and forgotten here is a
     * deployment that boots with it undefined — and the ones that matter most fail
     * quietly: no LEGACY_DB_HOST is a platform that scores nothing, and
     * SHIFT_RUNNER_ENABLED unset is a scheduler that never ticks.
     */
    const example = read('.env.example');
    const source = ['src/config/env.validation.ts', 'src/database/data-source.ts',
      'src/legacy/legacy-source.ts', 'src/shift/services/shift-scheduler.service.ts']
      .map((f) => read(f)).join('\n');

    const used = new Set<string>();
    for (const [, name] of source.matchAll(/(?:process\.)?env[.[]'?([A-Z][A-Z0-9_]{3,})'?\]?/g)) {
      used.add(name);
    }
    // Set by the platform, not by us.
    const PROVIDED = new Set(['NODE_ENV', 'PORT']);
    const missing = [...used].filter((n) => !PROVIDED.has(n) && !example.includes(n)).sort();
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(5);
  });
});
