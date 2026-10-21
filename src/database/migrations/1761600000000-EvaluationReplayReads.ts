import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the recommendation replay reads (task QEVAL1c), granted to `ta_eval` in its own
 * migration as `Evaluation1761300000000` said a later part would.
 *
 * Reads only. The replay recomputes QREC1's evidence bundles and QREC2's frames in
 * memory, and the point of granting `ta_eval` no write on `rec_evidence_bundle` or
 * `rec_frame` is that a replay which tried to store one — through shared code that
 * persists by habit — is refused by the database rather than quietly adding a bundle
 * the machine page would then show as current (G10).
 */
export class EvaluationReplayReads1761600000000 implements MigrationInterface {
  name = 'EvaluationReplayReads1761600000000';

  /** What QREC1's five steps read, beyond what the backtest already granted. */
  private readonly reads = [
    'equipment_service_record', 'incident', 'client_equipment_class', 'client_equipment_class_failure_mode',
    'client_equipment_class_recommendation', 'signal_binding_version', 'tenant_parameter',
  ];

  public async up(q: QueryRunner): Promise<void> {
    for (const table of this.reads) await q.query(`GRANT SELECT ON "${table}" TO "ta_eval"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Only what this migration granted: the backtest's grants stay with the backtest.
    for (const table of this.reads) await q.query(`REVOKE SELECT ON "${table}" FROM "ta_eval"`);
  }
}
