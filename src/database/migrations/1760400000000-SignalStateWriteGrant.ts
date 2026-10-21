import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `ta_app` may write the signal-state vocabulary it was only ever allowed to read.
 *
 * SignalStates1758510000000 granted SELECT alone, but `PUT /device-catalog/signal-states/:role`
 * replaces a role's states as a whole — DELETE then INSERT, inside one transaction —
 * so every save has answered "permission denied for table signal_state" since the
 * table was created. Its spec drove the service through the owner connection, which
 * holds every privilege, so nothing ever ran the write as the role the service uses.
 *
 * DELETE and INSERT only: the replace never UPDATEs a row, and a privilege nothing
 * exercises is one nothing tests. Who may call the route is still decided by
 * `device-catalog.write` (Master Admin); this grant is what lets that caller's write
 * reach the table at all.
 */
export class SignalStateWriteGrant1760400000000 implements MigrationInterface {
  name = 'SignalStateWriteGrant1760400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`GRANT INSERT, DELETE ON "signal_state" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`REVOKE INSERT, DELETE ON "signal_state" FROM "ta_app"`);
  }
}
