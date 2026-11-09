import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { ClassRequestService } from '../src/client-catalog/class-requests';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'ClassRequests1764300000000';

/**
 * Asking Things Alive for a class the library does not have (test report OB-6): the
 * account asks and can see where its request is; staff answer it, and an answer means
 * something — published names the class, declined says why, and neither reopens.
 */
describeDb('class requests', () => {
  let owner: DataSource;
  let ds: DataSource;
  let requests: ClassRequestService;

  const acme: RequestScope = { tenantId: 'acme', userId: 'u-acme', roles: ['super admin'], isPlatformRole: false };
  const globex: RequestScope = { tenantId: 'globex', userId: 'u-globex', roles: ['super admin'], isPlatformRole: false };
  const staff: RequestScope = { tenantId: '', userId: 'u-staff', roles: ['master-admin'], isPlatformRole: true };
  const ask = (scope = acme, machineType = 'Borewell submersible pump, 3-phase') =>
    requests.create(scope, { machineType, manufacturer: 'Crompton', model: '100W5', signals: ['motor_current', ' supply_voltage ', 'motor_current'] });

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    requests = new ClassRequestService(ds);
    await owner.query(
      `INSERT INTO equipment_class_profile (slug, version, name, category, status, expected_signals, failure_modes, default_thresholds)
       VALUES ('borewell-pump-3ph', 1, 'Borewell pump', 'pump', 'published', '[]', '[]', '{}')`);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });
  beforeEach(async () => { await owner.query(`DELETE FROM class_request`); });

  describe('the account', () => {
    it('asks, and sees its request as new, signals tidied', async () => {
      const r = await ask();
      expect(r.status).toBe('new');
      expect(r.signals).toEqual(['motor_current', 'supply_voltage']);
      expect((await requests.listOwn(acme)).map((x) => x.id)).toEqual([r.id]);
    });

    it('sees only its own requests', async () => {
      await ask(acme);
      await ask(globex, 'Diesel generator 250 kVA');
      expect((await requests.listOwn(globex)).map((x) => x.machineType)).toEqual(['Diesel generator 250 kVA']);
    });

    it('cannot work the queue', async () => {
      const r = await ask();
      await expect(requests.update(acme, r.id, { status: 'published', publishedClassSlug: 'borewell-pump-3ph' })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(requests.queue(acme)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('Things Alive staff', () => {
    it('see every account\'s open requests, oldest first, answered ones after', async () => {
      const first = await ask(acme);
      const second = await ask(globex, 'Diesel generator 250 kVA');
      await requests.update(staff, first.id, { status: 'declined', staffNote: 'Covered by monoblock-pump-3ph.' });
      expect((await requests.queue(staff)).map((x) => x.id)).toEqual([second.id, first.id]);
      expect((await requests.queue(staff, 'new')).map((x) => x.id)).toEqual([second.id]);
    });

    it('publish names the class, and the account sees the answer', async () => {
      const r = await ask();
      await requests.update(staff, r.id, { status: 'in_progress' });
      const done = await requests.update(staff, r.id, { status: 'published', publishedClassSlug: 'borewell-pump-3ph' });
      expect(done.decidedBy).toBe('u-staff');
      const [mine] = await requests.listOwn(acme);
      expect([mine.status, mine.publishedClassSlug]).toEqual(['published', 'borewell-pump-3ph']);
    });

    it('cannot publish a class that is not in the library', async () => {
      const r = await ask();
      await expect(requests.update(staff, r.id, { status: 'published', publishedClassSlug: 'no-such-class' }))
        .rejects.toThrow(/No published class "no-such-class"/);
    });

    it('two answers at once: one lands, the other is told it is already answered', async () => {
      const r = await ask();
      const results = await Promise.allSettled([
        requests.update(staff, r.id, { status: 'published', publishedClassSlug: 'borewell-pump-3ph' }),
        requests.update(staff, r.id, { status: 'declined', staffNote: 'Not enough signals.' }),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(BadRequestException);
      expect(String(refused.reason.message)).toMatch(/already answered/);
    });
  });

  describe('the table refuses, whoever writes', () => {
    it('a published request with no class, a declined one with no reason', async () => {
      const r = await ask();
      await expect(owner.query(`UPDATE class_request SET status = 'published' WHERE id = $1`, [r.id])).rejects.toThrow(/ck_class_request_published/);
      await expect(owner.query(`UPDATE class_request SET status = 'declined' WHERE id = $1`, [r.id])).rejects.toThrow(/ck_class_request_declined/);
    });

    it('reopening an answered request', async () => {
      const r = await ask();
      await owner.query(`UPDATE class_request SET status = 'declined', staff_note = 'Duplicate.' WHERE id = $1`, [r.id]);
      await expect(owner.query(`UPDATE class_request SET status = 'new' WHERE id = $1`, [r.id])).rejects.toThrow(/ck_class_request_final/);
    });

    it('a request with no machine type worth the name', async () => {
      await expect(requests.create(acme, { machineType: ' x ' })).rejects.toThrow(/2 to 120 characters/);
    });
  });

  it('undoes its own migration, and the chain re-applies', async () => {
    const has = async () => (await owner.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'class_request'`)).length;
    await undoMigrationNamed(owner, MIGRATION);
    expect(await has()).toBe(0);
    await owner.runMigrations({ transaction: 'all' });
    expect(await has()).toBe(1);
  });
});
