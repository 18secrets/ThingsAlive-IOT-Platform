import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The proposal substrate, the replay record, and the switch an unvalidated rule waits
 * behind (task QGEN1, D25, D27, D28).
 *
 * A generated artifact is a typed draft that has to survive a compiler, a replay over
 * real history and a person before it becomes anything. Every rule that keeps that true
 * is here rather than only in the service, because a service check loses to a concurrent
 * write or to a second door:
 *
 *  - `prediction` is not a kind (D26). No numeric value about the future originates from
 *    a language model, so there is no row in which one could;
 *  - a proposal's content never changes (G13): the approver approves exactly the bytes
 *    that were gated, and a changed artifact is a new proposal;
 *  - status only moves forward, so `rejected → approved` and `materialised → anything`
 *    are impossible however the service is called;
 *  - a refused gate cannot be approved (D28: "not a warning the user can wave past"), and
 *    only a kind that does not fire may skip replay;
 *  - a replay run is immutable — a re-gate is a new run, never an edited one;
 *  - a rule materialised from an `insufficient_history` proposal cannot be switched on
 *    until somebody has recorded that they chose to (question 8).
 */
export class ArtifactProposal1761800000000 implements MigrationInterface {
  name = 'ArtifactProposal1761800000000';

  /** The ceo-manager template before QGEN1 — see `grantToUneditedRoles`. */
  private readonly ceoManagerBefore = [
    'user.manage', 'role.manage', 'equipment.write',
    'scenario.activate', 'scenario.author', 'alert.author', 'action.work', 'action.assign',
    'catalog.read', 'client-catalog.read', 'client-catalog.write',
    'prediction.read', 'prediction.run', 'utilization.read',
    'device.read', 'device.claim',
    'equipment-template.read', 'device-catalog.read',
    'parameters.read', 'parameters.write',
    'shield.read', 'shield.write',
  ];

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "artifact_proposal" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "kind" text NOT NULL,
        "scope" text NOT NULL DEFAULT 'tenant',
        "status" text NOT NULL DEFAULT 'proposed',
        "seed" jsonb NOT NULL,
        "target" jsonb NOT NULL,
        "target_versions" jsonb NOT NULL,
        "payload" jsonb NOT NULL,
        "proposal_hash" text NOT NULL,
        "idempotency_key" text NOT NULL,
        "source" text NOT NULL DEFAULT 'generated',
        "emitter_kind" text NOT NULL,
        "emitter_version" text NOT NULL,
        "model_id" text,
        "model_version" text,
        "recommendation_id" uuid,
        "evidence_bundle_id" uuid,
        "evidence_hash" text,
        "compile_result" jsonb,
        "gate_outcome" text,
        "gate_detail" jsonb,
        "expires_at" timestamptz NOT NULL,
        "proposed_by" text NOT NULL,
        "approved_by" text,
        "approved_at" timestamptz,
        "rejected_by" text,
        "rejected_at" timestamptz,
        "rejection_reason" text,
        "materialised_ref" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        -- D26: prediction has no emitter. A CHECK rather than a service list, so no code
        -- path can store a generated forecast however it is reached.
        CONSTRAINT "ck_artifact_proposal_kind" CHECK ("kind" IN ('kpi', 'workflow')),
        CONSTRAINT "ck_artifact_proposal_scope" CHECK ("scope" IN ('tenant', 'class')),
        CONSTRAINT "ck_artifact_proposal_status" CHECK ("status" IN (
          'proposed', 'compile_refused', 'compiled', 'gate_refused', 'draft_ready',
          'approved', 'rejected', 'materialised', 'expired')),
        CONSTRAINT "ck_artifact_proposal_source" CHECK ("source" = 'generated'),
        CONSTRAINT "ck_artifact_proposal_emitter" CHECK (
          btrim("emitter_kind") <> '' AND btrim("emitter_version") <> ''),
        CONSTRAINT "ck_artifact_proposal_gate_outcome" CHECK ("gate_outcome" IS NULL OR "gate_outcome" IN (
          'pass', 'refuse', 'insufficient_history', 'not_applicable')),
        -- D28: the refusal is structured, not a warning to wave past.
        CONSTRAINT "ck_artifact_proposal_approvable" CHECK (
          "status" NOT IN ('approved', 'materialised')
          OR "gate_outcome" IN ('pass', 'insufficient_history', 'not_applicable')),
        -- Only a kind that does not fire may skip replay. A workflow cannot claim it does not apply.
        CONSTRAINT "ck_artifact_proposal_not_applicable" CHECK (
          "gate_outcome" IS DISTINCT FROM 'not_applicable' OR "kind" = 'kpi'),
        CONSTRAINT "ck_artifact_proposal_draft_ready" CHECK (
          "status" <> 'draft_ready' OR "gate_outcome" IN ('pass', 'insufficient_history', 'not_applicable')),
        CONSTRAINT "ck_artifact_proposal_gate_refused" CHECK (
          "status" <> 'gate_refused' OR "gate_outcome" = 'refuse'),
        CONSTRAINT "ck_artifact_proposal_approval" CHECK (("approved_by" IS NULL) = ("approved_at" IS NULL)),
        CONSTRAINT "ck_artifact_proposal_rejection" CHECK (
          ("rejected_by" IS NULL) = ("rejected_at" IS NULL)),
        CONSTRAINT "ck_artifact_proposal_materialised" CHECK (
          ("status" = 'materialised') = ("materialised_ref" IS NOT NULL))
      )`);
    // The retried emit's guarantee: the index decides, the service only reads the winner.
    await q.query(`CREATE UNIQUE INDEX "uq_artifact_proposal_idempotency" ON "artifact_proposal" ("tenant_id", "idempotency_key")`);
    // The target of the tenant-carrying foreign keys below: a replay run or a generated
    // workflow version in one account cannot name another account's proposal.
    await q.query(`CREATE UNIQUE INDEX "uq_artifact_proposal_tenant_id" ON "artifact_proposal" ("tenant_id", "id")`);
    await q.query(`CREATE INDEX "ix_artifact_proposal_list" ON "artifact_proposal" ("tenant_id", "kind", "status", "created_at")`);

    await q.query(`
      CREATE FUNCTION "artifact_proposal_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."kind" IS DISTINCT FROM OLD."kind"
          OR NEW."scope" IS DISTINCT FROM OLD."scope" OR NEW."seed" IS DISTINCT FROM OLD."seed"
          OR NEW."target" IS DISTINCT FROM OLD."target" OR NEW."target_versions" IS DISTINCT FROM OLD."target_versions"
          OR NEW."payload" IS DISTINCT FROM OLD."payload" OR NEW."proposal_hash" IS DISTINCT FROM OLD."proposal_hash"
          OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key" OR NEW."source" IS DISTINCT FROM OLD."source"
          OR NEW."emitter_kind" IS DISTINCT FROM OLD."emitter_kind" OR NEW."emitter_version" IS DISTINCT FROM OLD."emitter_version"
          OR NEW."model_id" IS DISTINCT FROM OLD."model_id" OR NEW."model_version" IS DISTINCT FROM OLD."model_version"
          OR NEW."recommendation_id" IS DISTINCT FROM OLD."recommendation_id"
          OR NEW."evidence_bundle_id" IS DISTINCT FROM OLD."evidence_bundle_id"
          OR NEW."evidence_hash" IS DISTINCT FROM OLD."evidence_hash"
          OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" OR NEW."proposed_by" IS DISTINCT FROM OLD."proposed_by"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
          RAISE EXCEPTION 'proposal % cannot change its content; a changed artifact is a new proposal', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        -- Each outcome belongs to the step that wrote it, and is written once.
        IF (OLD."status" <> 'proposed' AND NEW."compile_result" IS DISTINCT FROM OLD."compile_result")
          OR (OLD."status" NOT IN ('proposed', 'compiled') AND (
               NEW."gate_outcome" IS DISTINCT FROM OLD."gate_outcome" OR NEW."gate_detail" IS DISTINCT FROM OLD."gate_detail"))
          OR (OLD."approved_at" IS NOT NULL AND (
               NEW."approved_by" IS DISTINCT FROM OLD."approved_by" OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at"))
          OR (OLD."rejected_at" IS NOT NULL AND (
               NEW."rejected_by" IS DISTINCT FROM OLD."rejected_by" OR NEW."rejected_at" IS DISTINCT FROM OLD."rejected_at"
               OR NEW."rejection_reason" IS DISTINCT FROM OLD."rejection_reason"))
          OR (OLD."materialised_ref" IS NOT NULL AND NEW."materialised_ref" IS DISTINCT FROM OLD."materialised_ref") THEN
          RAISE EXCEPTION 'proposal %: a recorded outcome cannot be rewritten', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF NOT (
             NEW."status" = OLD."status"
          OR (OLD."status" = 'proposed' AND NEW."status" IN ('compile_refused', 'compiled'))
          OR (OLD."status" = 'compiled' AND NEW."status" IN ('gate_refused', 'draft_ready'))
          OR (OLD."status" = 'draft_ready' AND NEW."status" IN ('approved', 'rejected', 'expired'))
          OR (OLD."status" = 'approved' AND NEW."status" = 'materialised')) THEN
          RAISE EXCEPTION 'proposal % cannot move from % to %', OLD."id", OLD."status", NEW."status"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_artifact_proposal_guard" BEFORE UPDATE ON "artifact_proposal"
        FOR EACH ROW EXECUTE FUNCTION "artifact_proposal_guard"()`);

    // G10's run namespace for replay: a replay's only output is rows here and the
    // proposal's gate_detail. Nothing it writes is read by production.
    await q.query(`
      CREATE TABLE "replay_run" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "proposal_id" uuid NOT NULL,
        "source_system" text NOT NULL,
        "external_id" text NOT NULL,
        "window_from" timestamptz NOT NULL,
        "window_to" timestamptz NOT NULL,
        "compiler_version" text NOT NULL,
        "signals" jsonb NOT NULL,
        "windows_evaluated" integer NOT NULL,
        "fires" integer NOT NULL,
        "fires_detail" jsonb NOT NULL,
        "outcome" text NOT NULL,
        "outcome_reason" text NOT NULL,
        "started_at" timestamptz NOT NULL,
        "finished_at" timestamptz NOT NULL,
        CONSTRAINT "fk_replay_run_proposal" FOREIGN KEY ("tenant_id", "proposal_id")
          REFERENCES "artifact_proposal" ("tenant_id", "id"),
        CONSTRAINT "ck_replay_run_outcome" CHECK ("outcome" IN ('pass', 'refuse', 'insufficient_history')),
        CONSTRAINT "ck_replay_run_window" CHECK ("window_from" < "window_to"),
        CONSTRAINT "ck_replay_run_counts" CHECK ("windows_evaluated" >= 0 AND "fires" >= 0),
        CONSTRAINT "ck_replay_run_reason" CHECK (btrim("outcome_reason") <> '')
      )`);
    await q.query(`CREATE INDEX "ix_replay_run_proposal" ON "replay_run" ("tenant_id", "proposal_id")`);

    // An approval's last line of defence once a rule is switched on: who chose to, and
    // what history the machine had when they did. Append-only like the replay.
    await q.query(`
      CREATE TABLE "proposal_rule_enablement" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "alert_rule_id" uuid NOT NULL REFERENCES "alert_rule" ("id"),
        "proposal_id" uuid NOT NULL,
        "enabled_by" text NOT NULL,
        "enabled_at" timestamptz NOT NULL DEFAULT now(),
        "history" jsonb NOT NULL,
        CONSTRAINT "fk_proposal_rule_enablement_proposal" FOREIGN KEY ("tenant_id", "proposal_id")
          REFERENCES "artifact_proposal" ("tenant_id", "id")
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_proposal_rule_enablement" ON "proposal_rule_enablement" ("tenant_id", "alert_rule_id")`);

    await q.query(`
      CREATE FUNCTION "proposal_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only; a re-gate or a second decision is a new row', TG_TABLE_NAME
          USING ERRCODE = 'check_violation';
      END $$`);
    for (const table of ['replay_run', 'proposal_rule_enablement']) {
      await q.query(`
        CREATE TRIGGER "trg_${table}_append_only" BEFORE UPDATE OR DELETE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION "proposal_append_only"()`);
    }

    for (const table of ['artifact_proposal', 'replay_run', 'proposal_rule_enablement']) {
      await q.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await q.query(`
        CREATE POLICY "tenant_isolation" ON "${table}"
          USING (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))
          WITH CHECK (current_setting('ta.bypass', true) = 'on' OR "tenant_id" = current_setting('ta.tenant_id', true))`);
    }
    // No DELETE anywhere: a materialised artifact and every replay point back here.
    await q.query(`GRANT SELECT, INSERT, UPDATE ON "artifact_proposal" TO "ta_app"`);
    await q.query(`GRANT SELECT, INSERT ON "replay_run", "proposal_rule_enablement" TO "ta_app"`);

    // QWF1 reserved `proposal_id` on a workflow version; this gives it something to point at.
    // NOT VALID: every new or changed row is checked, rows already there are not. On a
    // first deploy there are none to check — nothing could set the column before this —
    // but after a down and up a published version still names the proposal it came from,
    // and a published version cannot be edited to forget it.
    await q.query(`
      ALTER TABLE "workflow_version" ADD CONSTRAINT "fk_workflow_version_proposal"
        FOREIGN KEY ("tenant_id", "proposal_id") REFERENCES "artifact_proposal" ("tenant_id", "id") NOT VALID`);

    // D28: an insufficient_history draft cannot be auto-enabled. Keyed off the proposal
    // the rule's version came from, so it holds for whatever writes the rule — the
    // emitter, QWF1's publish, the rule switch, or a direct UPDATE.
    await q.query(`
      CREATE FUNCTION "alert_rule_unvalidated_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_outcome text;
      BEGIN
        IF NOT NEW."enabled" OR NEW."compiled_from_version_id" IS NULL THEN
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD."enabled" THEN
          RETURN NEW;
        END IF;
        SELECT p."gate_outcome" INTO v_outcome
          FROM "workflow_version" v
          JOIN "artifact_proposal" p ON p."tenant_id" = v."tenant_id" AND p."id" = v."proposal_id"
         WHERE v."id" = NEW."compiled_from_version_id";
        IF v_outcome = 'insufficient_history' AND NOT EXISTS (
             SELECT 1 FROM "proposal_rule_enablement" e
              WHERE e."tenant_id" = NEW."tenant_id" AND e."alert_rule_id" = NEW."id") THEN
          RAISE EXCEPTION 'alert rule % was generated without enough history to replay; enable it through its proposal, which records who chose to', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "trg_alert_rule_unvalidated_guard" BEFORE INSERT OR UPDATE OF "enabled" ON "alert_rule"
        FOR EACH ROW EXECUTE FUNCTION "alert_rule_unvalidated_guard"()`);

    await this.grantToUneditedRoles(q);
  }

  /**
   * Accounts provisioned before this migration hold a ceo-manager role without
   * `proposal.approve`, so nobody in them could approve a generated draft (question 3).
   * Only a role still exactly the template default is touched — the same reasoning as
   * `ShieldEvidence1759400000000`: an edited role is the client's.
   */
  private async grantToUneditedRoles(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE "tenant_role" SET "capabilities" = "capabilities" || $2::text[]
         WHERE "template_slug" = 'ceo-manager' AND "capabilities" @> $1::text[] AND "capabilities" <@ $1::text[]`,
      [this.ceoManagerBefore, ['proposal.approve']],
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    // The role grant is not taken back: the capability simply stops matching any route.
    await q.query(`DROP TRIGGER IF EXISTS "trg_alert_rule_unvalidated_guard" ON "alert_rule"`);
    await q.query(`DROP FUNCTION IF EXISTS "alert_rule_unvalidated_guard"()`);
    // The column is QWF1's and stays, with whatever it holds; only the key goes.
    await q.query(`ALTER TABLE "workflow_version" DROP CONSTRAINT IF EXISTS "fk_workflow_version_proposal"`);
    await q.query(`DROP TABLE IF EXISTS "proposal_rule_enablement"`);
    await q.query(`DROP TABLE IF EXISTS "replay_run"`);
    await q.query(`DROP FUNCTION IF EXISTS "proposal_append_only"()`);
    await q.query(`DROP TABLE IF EXISTS "artifact_proposal"`);
    await q.query(`DROP FUNCTION IF EXISTS "artifact_proposal_guard"()`);
  }
}
