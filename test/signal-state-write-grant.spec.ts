import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../src/auth/types/request-scope';
import { SignalStateService } from '../src/device-catalog/services/signal-state.service';
import { createAppDataSource, createTestDataSource, describeDb, undoMigrationNamed } from './db';

const MIGRATION = 'SignalStateWriteGrant1760400000000';

/**
 * Saving a signal-state vocabulary, as the service actually runs it.
 *
 * categorical-signals.spec.ts drives SignalStateService through the owner connection,
 * which holds every privilege — so its replace tests passed while every real save, made
 * as `ta_app`, failed with "permission denied for table signal_state". Everything here
 * goes through the application connection; a test run as the owner proves nothing about
 * what the running service may do.
 */
describeDb('signal states: ta_app may save a vocabulary', () => {
  let owner: DataSource;
  let ds: DataSource;
  let states: SignalStateService;

  const master: RequestScope = { tenantId: 'things-alive', userId: 'u-master', roles: ['master-admin'], isPlatformRole: true };
  const codes = async (role: string) => (await ds.query(
    `SELECT "state", "code" FROM "signal_state" WHERE "measurement_role" = $1 ORDER BY "code"`, [role],
  )) as { state: string; code: number }[];

  beforeAll(async () => {
    owner = await createTestDataSource();
    await owner.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await owner.runMigrations({ transaction: 'all' });
    ds = await createAppDataSource();
    states = new SignalStateService(ds);
  }, 30_000);

  afterAll(async () => { await ds?.destroy(); await owner?.destroy(); });

  beforeEach(async () => { await owner.query(`DELETE FROM "signal_state"`); });

  it('a save reaches the table, and a second save replaces the first as a whole', async () => {
    await states.replace(master, 'ignition_status', [{ state: 'off', code: 0 }, { state: 'on', code: 1 }]);
    await states.replace(master, 'ignition_status', [{ state: 'off', code: 0 }, { state: 'fault', code: 9 }]);
    expect(await codes('ignition_status')).toEqual([{ state: 'off', code: 0 }, { state: 'fault', code: 9 }]);
  });

  it('the database still refuses two states on one code, and the refused save changes nothing', async () => {
    await states.replace(master, 'ignition_status', [{ state: 'off', code: 0 }, { state: 'on', code: 1 }]);
    await expect(states.replace(master, 'ignition_status', [{ state: 'off', code: 0 }, { state: 'on', code: 0 }]))
      .rejects.toThrow(BadRequestException);
    expect(await codes('ignition_status')).toEqual([{ state: 'off', code: 0 }, { state: 'on', code: 1 }]);
  });

  // The grant is DELETE + INSERT because that is all the replace does. UPDATE stays
  // refused, so a later edit path has to come back here and say it needs one.
  it('ta_app still may not UPDATE a state in place', async () => {
    await states.replace(master, 'ignition_status', [{ state: 'off', code: 0 }]);
    await expect(ds.query(`UPDATE "signal_state" SET "code" = 5 WHERE "measurement_role" = 'ignition_status'`))
      .rejects.toMatchObject({ code: '42501' });
  });

  it(`${MIGRATION} runs down and up again: down puts the refusal back`, async () => {
    await undoMigrationNamed(owner, MIGRATION);
    await expect(states.replace(master, 'ignition_status', [{ state: 'off', code: 0 }]))
      .rejects.toMatchObject({ code: '42501' });
    await owner.runMigrations({ transaction: 'all' });
    await states.replace(master, 'ignition_status', [{ state: 'off', code: 0 }]);
    expect(await codes('ignition_status')).toEqual([{ state: 'off', code: 0 }]);
  });
});
