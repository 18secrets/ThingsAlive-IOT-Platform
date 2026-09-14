import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createApp } from '../src/main';
import { HealthController } from '../src/health/health.controller';
import { LegacyTelemetryReader } from '../src/legacy/legacy-telemetry.reader';
import { probe, summarise, STATUS_CODE, PROBE_TIMEOUT_MS } from '../src/health/readiness';

/**
 * Task D-04 — readiness means something.
 *
 * What this file exists to prevent is the state it replaced: /ready returned a
 * hardcoded `status: 'ok'` with `database: 'not_configured'` beside it, and it did so
 * for months after the database was configured. Nothing failed, because nothing was
 * checking — that is the failure mode. Railway gates a release on this endpoint, so a
 * probe that cannot say no turns the gate into a formality and a release that cannot
 * reach its database takes traffic.
 *
 * The probe is exercised against fakes rather than a real outage, because the case
 * that matters is the one nobody can stage: the database that is configured, reachable
 * at boot, and gone by the time the new version asks.
 */

type Behaviour = 'ok' | 'throws' | 'hangs' | 'down';

/** The health controller reads the existing platform through its module's reader. */
const fakeLegacy = (behaviour: Behaviour): LegacyTelemetryReader =>
  ({ probeConnection: () => probe(fakeDs(behaviour)) }) as unknown as LegacyTelemetryReader;

/** Just enough DataSource for the probe: it looks at isInitialized and asks once. */
const fakeDs = (behaviour: Behaviour): DataSource =>
  ({
    isInitialized: behaviour !== 'down',
    query: async () => {
      if (behaviour === 'throws') throw new Error('connection terminated unexpectedly');
      if (behaviour === 'hangs') return new Promise(() => {});
      return [{ '?column?': 1 }];
    },
  }) as unknown as DataSource;

describe('readiness probe (D-04)', () => {
  describe('one dependency', () => {
    it('answers ok when the database answers', async () => {
      await expect(probe(fakeDs('ok'))).resolves.toBe('ok');
    });

    it('answers not_configured when there is no connection to probe', async () => {
      // Distinct from unreachable on purpose: a process built without a database is a
      // deliberate configuration, and calling it a failure would fail every spec that
      // boots the HTTP layer alone.
      await expect(probe(null)).resolves.toBe('not_configured');
      await expect(probe(undefined)).resolves.toBe('not_configured');
    });

    it('answers unreachable for a connection that exists but is not initialised', async () => {
      await expect(probe(fakeDs('down'))).resolves.toBe('unreachable');
    });

    it('answers unreachable when the query fails', async () => {
      await expect(probe(fakeDs('throws'))).resolves.toBe('unreachable');
    });

    it('answers unreachable when the query hangs, rather than hanging with it', async () => {
      // A probe that waits forever is indistinguishable to the platform from one that
      // fails, except it takes the whole healthcheck window with it.
      const started = Date.now();
      await expect(probe(fakeDs('hangs'), 50)).resolves.toBe('unreachable');
      expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS);
    });
  });

  describe('the verdict', () => {
    it('is ok only when everything answered', () => {
      expect(summarise({ database: 'ok', legacy: 'ok' })).toBe('ok');
    });

    it('is not_ready when the platform database is unreachable', () => {
      expect(summarise({ database: 'unreachable', legacy: 'ok' })).toBe('not_ready');
      expect(STATUS_CODE[summarise({ database: 'unreachable', legacy: 'ok' })]).toBe(503);
    });

    it('is degraded, not not_ready, when only the legacy connection is down', () => {
      // Deliberate. Gating our releases on their database means their maintenance
      // window blocks our deploys, and scoring is already built to wait: the windows
      // stay owed and are taken when a route comes back.
      const status = summarise({ database: 'ok', legacy: 'unreachable' });
      expect(status).toBe('degraded');
      expect(STATUS_CODE[status]).toBe(200);
    });

    it('is degraded when the legacy connection is simply not configured yet', () => {
      expect(summarise({ database: 'ok', legacy: 'not_configured' })).toBe('degraded');
    });
  });

  describe('over HTTP', () => {
    let app: INestApplication;

    beforeAll(async () => {
      process.env.AUTH_JWT_SECRET = 'test-secret';
      process.env.CORS_ORIGINS = 'http://localhost:3000';
      app = await createApp({ database: false });
      await app.init();
    });

    afterAll(async () => { await app?.close(); });

    it('serves readiness without a token', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/ready');
      expect(res.status).toBe(200);
      expect(res.body.checks).toHaveProperty('database');
      expect(res.body.checks).toHaveProperty('legacy');
    });

    it('returns 503 with the checks in the body when the database does not answer', async () => {
      const controller = new HealthController(fakeDs('throws'), fakeLegacy('ok'));
      let code = 200;
      const body = await controller.ready({ status: (c: number) => (code = c) });

      expect(code).toBe(503);
      // The body is the same shape either way. Whoever opens this URL during an
      // incident wants to see which dependency is down, not an error envelope saying
      // that one is.
      expect(body.status).toBe('not_ready');
      expect(body.checks).toEqual({ database: 'unreachable', legacy: 'ok' });
      expect(typeof body.time).toBe('string');
    });

    it('stays 200 and reports degraded when only the legacy connection is down', async () => {
      const controller = new HealthController(fakeDs('ok'), fakeLegacy('throws'));
      let code = 0;
      const body = await controller.ready({ status: (c: number) => (code = c) });

      expect(code).toBe(200);
      expect(body.status).toBe('degraded');
      expect(body.checks.legacy).toBe('unreachable');
    });
  });
});
