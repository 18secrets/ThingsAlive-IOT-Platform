import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AlertRule } from '../alert/entities/alert-rule.entity';
import { can } from '../auth/capabilities';
import { RequestScope } from '../auth/types/request-scope';
import { ClientEquipmentClass } from '../client-catalog/entities/client-equipment-class.entity';
import { withTenantSession } from '../scope/tenant-session';
import { SignalBindingVersion } from '../signal-binding/entities/signal-binding-version.entity';
import { WorkflowVersion } from '../workflow/entities/workflow-version.entity';
import { canonicalJson } from '../workflow/workflow-spec';
import { EmitContext, EmitterRegistry, ReplayPlan, TARGET_VERSION_KEYS, TargetVersions } from './emitter';
import { ArtifactProposal } from './entities/artifact-proposal.entity';
import { ProposalRuleEnablement } from './entities/proposal-rule-enablement.entity';
import { ReplayRun } from './entities/replay-run.entity';
import {
  FIRES, GateOutcome, PROPOSAL_KINDS, PROPOSAL_LIFETIME_MS, ProposalKind, ProposalScope, ProposalStatus,
  REPLAY_MACHINE_CAP, replayMaxFires,
} from './proposal-kinds';
import { MachineReplay, ReplayService } from './replay.service';

const UUID = /^[0-9a-f-]{36}$/i;

export interface ProposeInput {
  kind: string;
  scope?: ProposalScope;
  seed: Record<string, unknown>;
  idempotencyKey: string;
}

export type ProposeResult =
  | { status: 'needs_input'; missing: { field: string; reason: string; detail: string }[] }
  | ProposalView;

export type Readiness = 'ready' | 'pending' | 'blocked';

export interface ProposalView {
  id: string;
  kind: ProposalKind;
  scope: ProposalScope;
  status: ProposalStatus;
  gateOutcome: GateOutcome | null;
  /** The platform's readiness vocabulary (§7): a draft nobody may switch on is never "ready". */
  readiness: Readiness;
  reason: string | null;
  sentence: string;
  /** True when the gate could not validate it: what history it had is in `gateDetail`. */
  unvalidated: boolean;
  expired: boolean;
  expiresAt: Date;
  seed: Record<string, unknown>;
  target: Record<string, unknown>;
  targetVersions: Record<string, unknown>;
  payload: Record<string, unknown>;
  rendering: string[];
  compileResult: Record<string, unknown> | null;
  gateDetail: Record<string, unknown> | null;
  provenance: {
    source: 'generated'; emitterKind: string; emitterVersion: string; modelId: string | null; modelVersion: string | null;
    recommendationId: string | null; evidenceBundleId: string | null; evidenceHash: string | null;
    proposalHash: string; proposedBy: string; proposedAt: Date;
  };
  approval: { by: string; at: Date } | null;
  rejection: { by: string; at: Date; reason: string | null } | null;
  materialisedRef: Record<string, unknown> | null;
  replayRuns?: Omit<ReplayRun, 'firesDetail' | 'tenantId'>[];
}

/**
 * The proposal substrate (task QGEN1, D25, D27, D28): seed → emit → compile → gate →
 * draft → approve → materialise, with per-kind emitters plugged in.
 *
 * Each step is its own transaction and its own state change, and the database decides
 * which changes are legal — this service is one caller of those rules, not their
 * keeper. A compile refusal is the compiler's own message, stored and final: repairing
 * or re-prompting here would be a second author nobody reviews.
 *
 * There is no public way to create a proposal. QGEN2 and QGEN3 call `propose` from a
 * person's selection; a route that took an arbitrary payload would let anyone skip an
 * emitter's closed vocabulary.
 */
@Injectable()
export class ProposalService {
  constructor(
    private readonly ds: DataSource,
    private readonly registry: EmitterRegistry,
    private readonly replays: ReplayService,
  ) {}

  // ---------------------------------------------------------------- propose

  async propose(scope: RequestScope, input: ProposeInput, at = new Date()): Promise<ProposeResult> {
    if (!(PROPOSAL_KINDS as readonly string[]).includes(input.kind)) {
      // D26 names prediction specifically; anything else is simply not a kind.
      throw new BadRequestException(input.kind === 'prediction'
        ? 'Prediction has no emitter: no value about the future may come from a generated artifact (D26).'
        : `"${input.kind}" is not a proposal kind.`);
    }
    const kind = input.kind as ProposalKind;
    const emitter = this.registry.get(kind);
    if (!emitter) throw new BadRequestException(`No emitter is registered for "${kind}" yet.`);
    if (!input.idempotencyKey?.trim()) throw new BadRequestException('A proposal needs an idempotency key, so a retried emit returns the same one.');
    const proposalScope = input.scope ?? 'tenant';

    const step = await withTenantSession(this.ds, scope, async (m) => {
      const existing = await this.byKey(m, scope.tenantId, input.idempotencyKey);
      if (existing) return { id: existing.id, created: false as const };

      const emitted = await emitter.emit(input.seed, { scope, proposalScope, m, at });
      if (emitted.status === 'needs_input') return { needsInput: emitted };
      const unknown = Object.keys(emitted.targetVersions).filter((k) => !TARGET_VERSION_KEYS.includes(k as keyof TargetVersions));
      if (unknown.length) throw new Error(`Emitter "${kind}" pinned "${unknown[0]}", which approval cannot recheck.`);

      const hash = createHash('sha256').update(canonicalJson({
        kind, scope: proposalScope, target: emitted.target, targetVersions: emitted.targetVersions, payload: emitted.payload,
      })).digest('hex');
      // The unique index decides a race between two emits with one key; the loser reads
      // the winner's row instead of writing its own.
      const inserted: { id: string }[] = await m.query(
        `INSERT INTO "artifact_proposal" ("tenant_id", "kind", "scope", "status", "seed", "target", "target_versions",
           "payload", "proposal_hash", "idempotency_key", "emitter_kind", "emitter_version", "model_id", "model_version",
           "recommendation_id", "evidence_bundle_id", "evidence_hash", "expires_at", "proposed_by", "created_at", "updated_at")
         VALUES ($1, $2, $3, 'proposed', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19)
         ON CONFLICT ("tenant_id", "idempotency_key") DO NOTHING
         RETURNING "id"`,
        [scope.tenantId, kind, proposalScope, input.seed, emitted.target, emitted.targetVersions, emitted.payload, hash,
          input.idempotencyKey, emitter.kind, emitter.version, emitted.modelId ?? null, emitted.modelVersion ?? null,
          emitted.recommendationId ?? null, emitted.evidenceBundleId ?? null, emitted.evidenceHash ?? null,
          new Date(at.getTime() + PROPOSAL_LIFETIME_MS), scope.userId, at],
      );
      if (inserted.length) return { id: inserted[0].id, created: true as const };
      return { id: (await this.byKey(m, scope.tenantId, input.idempotencyKey))!.id, created: false as const };
    });
    if ('needsInput' in step) return step.needsInput!;

    if (step.created) {
      await this.compile(scope, step.id, at);
      await this.gate(scope, step.id, at);
    }
    return this.get(scope, step.id, at);
  }

  private async compile(scope: RequestScope, id: string, at: Date): Promise<void> {
    await withTenantSession(this.ds, scope, async (m) => {
      const p = await this.locked(m, scope, id);
      if (p.status !== 'proposed') return;
      const emitter = this.registry.get(p.kind)!;
      const out = await emitter.compile(p.payload, this.ctx(scope, p.scope, m, at));
      await m.getRepository(ArtifactProposal).update({ id }, out.ok === true
        ? { status: 'compiled', compileResult: { ...out.result, ...(out.replay ? { replayPlan: out.replay } : {}) }, updatedAt: at }
        : { status: 'compile_refused', compileResult: { refused: true, message: out.message }, updatedAt: at });
    });
  }

  /**
   * Deterministic, no model (D28). A kind that fires is replayed over every machine its
   * target covers; one that does not is `not_applicable`, plus whatever checks its
   * emitter adds. The replay reads in its own read-only transaction; its result is
   * recorded in a second one, under the proposal's lock.
   */
  private async gate(scope: RequestScope, id: string, at: Date): Promise<void> {
    const p = await withTenantSession(this.ds, scope, (m) => this.locked(m, scope, id));
    if (p.status !== 'compiled') return;

    let outcome: GateOutcome;
    let detail: Record<string, unknown>;
    let runs: MachineReplay[] = [];
    if (FIRES[p.kind]) {
      const plan = p.compileResult?.replayPlan as ReplayPlan | undefined;
      if (!plan) {
        outcome = 'refuse';
        detail = { reason: 'The compiler returned no replay plan for a kind that fires, so nothing could be replayed.' };
      } else if (plan.machines.length > REPLAY_MACHINE_CAP) {
        outcome = 'refuse';
        detail = { reason: `The target covers ${plan.machines.length} machines; a proposal may replay against at most ${REPLAY_MACHINE_CAP}.`, machineCap: REPLAY_MACHINE_CAP };
      } else if (plan.machines.length === 0) {
        outcome = 'insufficient_history';
        detail = { reason: 'The target covers no machine, so there is no history to replay.' };
      } else {
        runs = await this.replays.replay(scope.tenantId, plan, at);
        // Question 7, worst case: any refusal refuses; otherwise any machine short of
        // history leaves the whole draft unvalidated. Every machine's run is shown.
        outcome = runs.some((r) => r.outcome === 'refuse') ? 'refuse'
          : runs.some((r) => r.outcome === 'insufficient_history') ? 'insufficient_history' : 'pass';
        const worst = runs.find((r) => r.outcome === outcome)!;
        detail = {
          reason: worst.outcomeReason,
          maxFiresPerMachine: replayMaxFires(),
          machines: runs.map((r) => ({
            sourceSystem: r.sourceSystem, externalId: r.externalId, outcome: r.outcome, reason: r.outcomeReason,
            fires: r.fires, windowsEvaluated: r.windowsEvaluated, signals: r.signals,
            firstFirings: r.firesDetail.windows.slice(0, 3),
          })),
        };
      }
    } else {
      const emitter = this.registry.get(p.kind)!;
      const checks = emitter.checks
        ? await withTenantSession(this.ds, scope, (m) => emitter.checks!(p.payload, p.compileResult ?? {}, this.ctx(scope, p.scope, m, at)))
        : { detail: {} };
      outcome = checks.refuse ? 'refuse' : 'not_applicable';
      detail = { ...checks.detail, reason: checks.refuse ?? 'A kind that does not fire is not replayed (D28).' };
    }

    await withTenantSession(this.ds, scope, async (m) => {
      const again = await this.locked(m, scope, id);
      if (again.status !== 'compiled') return;
      if (runs.length) {
        const repo = m.getRepository(ReplayRun);
        await repo.save(runs.map((r) => repo.create({
          tenantId: scope.tenantId, proposalId: id, sourceSystem: r.sourceSystem, externalId: r.externalId,
          windowFrom: r.windowFrom, windowTo: r.windowTo, compilerVersion: r.compilerVersion,
          signals: r.signals as unknown as Record<string, unknown>[], windowsEvaluated: r.windowsEvaluated, fires: r.fires,
          firesDetail: r.firesDetail as unknown as Record<string, unknown>, outcome: r.outcome, outcomeReason: r.outcomeReason,
          startedAt: r.startedAt, finishedAt: r.finishedAt,
        })));
      }
      await m.getRepository(ArtifactProposal).update({ id }, {
        status: outcome === 'refuse' ? 'gate_refused' : 'draft_ready', gateOutcome: outcome, gateDetail: detail, updatedAt: at,
      });
    });
  }

  // ---------------------------------------------------------------- decide

  /**
   * Approve and materialise, in one transaction under the proposal's row lock — two
   * overlapping approvals must not materialise twice (the import-batch lesson).
   * Idempotent: a materialised proposal returns as it is and writes nothing.
   *
   * Rechecks before it writes (shared contract §5): the scope still routes here, the
   * proposal has not expired, and every version it was gated against is still current.
   * A failed recheck is a 409 naming which, and the proposal stays `draft_ready` — it is
   * not re-gated in place, because the gate's result belongs to the content it gated.
   */
  async approve(scope: RequestScope, id: string, at = new Date()): Promise<ProposalView> {
    if (!can(scope, 'proposal.approve')) throw new ForbiddenException('Approving a generated draft needs proposal.approve.');
    await withTenantSession(this.ds, scope, async (m) => {
      const p = await this.locked(m, scope, id);
      if (p.status === 'materialised') return;
      if (p.status !== 'draft_ready') {
        throw new ConflictException({ reason: 'not_approvable', status: p.status, message: `A ${p.status.replace('_', ' ')} proposal cannot be approved.` });
      }
      if (p.scope === 'class') {
        throw new ConflictException({ reason: 'class_scope_undecided',
          message: 'Class-scope approval is not built: what may reach Things Alive from one account\'s evidence is undecided (QGEN1 question 2).' });
      }
      if (at > p.expiresAt) throw new ConflictException({ reason: 'expired', message: `This proposal expired at ${p.expiresAt.toISOString()}; propose again.` });
      const stale = await this.recheck(m, scope.tenantId, p.targetVersions as TargetVersions);
      if (stale) throw new ConflictException({ reason: 'stale_version', message: stale });
      const emitter = this.registry.get(p.kind);
      if (!emitter) throw new ConflictException({ reason: 'no_emitter', message: `No emitter is registered for "${p.kind}".` });

      const repo = m.getRepository(ArtifactProposal);
      await repo.update({ id }, { status: 'approved', approvedBy: scope.userId, approvedAt: at, updatedAt: at });
      const ref = await emitter.materialise(p.payload, {
        scope, at, unvalidated: p.gateOutcome === 'insufficient_history',
        proposal: { id, scope: p.scope, gateOutcome: p.gateOutcome!, targetVersions: p.targetVersions as TargetVersions },
      }, m);
      await repo.update({ id }, { status: 'materialised', materialisedRef: ref, updatedAt: at });
    });
    return this.get(scope, id, at);
  }

  async reject(scope: RequestScope, id: string, reason: string | null, at = new Date()): Promise<ProposalView> {
    if (!can(scope, 'proposal.approve')) throw new ForbiddenException('Rejecting a generated draft needs proposal.approve.');
    await withTenantSession(this.ds, scope, async (m) => {
      const p = await this.locked(m, scope, id);
      if (p.status === 'rejected') return;
      if (p.status !== 'draft_ready') {
        throw new ConflictException({ reason: 'not_rejectable', status: p.status, message: `A ${p.status.replace('_', ' ')} proposal cannot be rejected.` });
      }
      await m.getRepository(ArtifactProposal).update({ id }, {
        status: 'rejected', rejectedBy: scope.userId, rejectedAt: at, rejectionReason: reason?.trim() || null, updatedAt: at,
      });
    });
    return this.get(scope, id, at);
  }

  /**
   * Question 8: a rule generated without enough history stays off until someone who
   * may author alerts chooses to switch it on, and the choice is recorded with the
   * history the machine had at that moment. The database refuses the switch without
   * that record, so this is the only way through. Idempotent.
   */
  async enableRule(scope: RequestScope, id: string, ruleId: string, at = new Date()) {
    if (!can(scope, 'alert.author')) throw new ForbiddenException('Switching on an alert rule needs alert.author.');
    if (!UUID.test(ruleId)) throw new NotFoundException('No such rule on this proposal.');
    return withTenantSession(this.ds, scope, async (m) => {
      const p = await this.locked(m, scope, id);
      if (p.status !== 'materialised' || p.gateOutcome !== 'insufficient_history') {
        throw new ConflictException({ reason: 'not_unvalidated', message: 'Only a rule materialised from an unvalidated draft is switched on here.' });
      }
      const rule = await m.getRepository(AlertRule).findOne({ where: { tenantId: scope.tenantId, id: ruleId } });
      const version = rule?.compiledFromVersionId
        ? await m.getRepository(WorkflowVersion).findOne({ where: { tenantId: scope.tenantId, id: rule.compiledFromVersionId } })
        : null;
      if (!rule || version?.proposalId !== id) throw new NotFoundException('No such rule on this proposal.');

      const existing = await m.getRepository(ProposalRuleEnablement).findOne({ where: { tenantId: scope.tenantId, alertRuleId: ruleId } });
      if (existing && rule.enabled) return { ruleId, enabled: true, enabledBy: existing.enabledBy, history: existing.history };

      const plan = p.compileResult?.replayPlan as ReplayPlan | undefined;
      const signals = [...new Set((plan?.rules ?? []).flatMap((r) => r.signals))];
      const machines = await Promise.all((plan?.machines ?? []).map(async (machine) => ({
        ...machine, signals: await this.replays.history(scope.tenantId, machine, signals, at),
      })));
      const history = existing?.history ?? { at: at.toISOString(), machines };
      if (!existing) {
        await m.query(
          `INSERT INTO "proposal_rule_enablement" ("tenant_id", "alert_rule_id", "proposal_id", "enabled_by", "enabled_at", "history")
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT ("tenant_id", "alert_rule_id") DO NOTHING`,
          [scope.tenantId, ruleId, id, scope.userId, at, history],
        );
      }
      await m.getRepository(AlertRule).update({ id: ruleId }, { enabled: true, updatedBy: scope.userId });
      return { ruleId, enabled: true, enabledBy: existing?.enabledBy ?? scope.userId, history };
    });
  }

  // ---------------------------------------------------------------- read

  async list(scope: RequestScope, filter: { kind?: string; status?: string } = {}, at = new Date()): Promise<ProposalView[]> {
    return withTenantSession(this.ds, scope, async (m) => {
      const rows = await m.getRepository(ArtifactProposal).find({
        where: {
          tenantId: scope.tenantId,
          ...(filter.kind ? { kind: filter.kind as ProposalKind } : {}),
          ...(filter.status ? { status: filter.status as ProposalStatus } : {}),
        },
        order: { createdAt: 'DESC' },
        take: 100,
      });
      return Promise.all(rows.map((p) => this.view(m, scope, p, at)));
    });
  }

  async get(scope: RequestScope, id: string, at = new Date()): Promise<ProposalView> {
    return withTenantSession(this.ds, scope, async (m) => {
      const p = await this.find(m, scope, id);
      const runs = await m.getRepository(ReplayRun).find({
        where: { tenantId: scope.tenantId, proposalId: id }, order: { externalId: 'ASC' },
      });
      return {
        ...(await this.view(m, scope, p, at)),
        replayRuns: runs.map(({ firesDetail: _d, tenantId: _t, ...run }) => run),
      };
    });
  }

  async replayRun(scope: RequestScope, id: string, runId: string): Promise<ReplayRun> {
    return withTenantSession(this.ds, scope, async (m) => {
      await this.find(m, scope, id);
      const run = UUID.test(runId)
        ? await m.getRepository(ReplayRun).findOne({ where: { tenantId: scope.tenantId, proposalId: id, id: runId } })
        : null;
      if (!run) throw new NotFoundException('No such replay run on this proposal.');
      return run;
    });
  }

  // ---------------------------------------------------------------- internals

  /** Every pinned version still current, or the first one that is not, named. */
  private async recheck(m: EntityManager, tenantId: string, versions: TargetVersions): Promise<string | null> {
    for (const c of versions.classCopies ?? []) {
      const now = await m.getRepository(ClientEquipmentClass).findOne({ where: { tenantId, slug: c.slug } });
      if (!now || now.status !== 'active' || now.templateVersion !== c.templateVersion || now.templateChecksum !== c.templateChecksum) {
        return `The class copy "${c.slug}" has changed since this proposal was gated.`;
      }
    }
    for (const b of versions.bindings ?? []) {
      const now = await m.getRepository(SignalBindingVersion).findOne({ where: { tenantId, id: b.id } });
      if (!now || now.status !== 'active' || now.validTo !== null || !now.isPrimary) {
        return `The binding for signal "${b.signalKey}" on ${b.externalId} has changed since the replay ran over it.`;
      }
    }
    for (const t of versions.alertTemplates ?? []) {
      const now = await m.getRepository(AlertRule).findOne({ where: { tenantId, id: t.ruleId } });
      if (!now || now.templateVersion !== t.templateVersion || now.templateChecksum !== t.templateChecksum) {
        return `The alert template "${t.templateSlug}" has changed since this proposal was gated.`;
      }
    }
    return null;
  }

  private async view(m: EntityManager, scope: RequestScope, p: ArtifactProposal, at: Date): Promise<ProposalView> {
    const emitter = this.registry.get(p.kind);
    const rendering = emitter ? await emitter.render(p.payload, { scope, m }).catch(() => []) : [];
    const expired = p.status === 'expired' || (p.status === 'draft_ready' && at > p.expiresAt);
    const unvalidated = p.gateOutcome === 'insufficient_history';
    const gateReason = (p.gateDetail?.reason as string | undefined) ?? null;
    const { readiness, reason, sentence } = expired
      ? { readiness: 'blocked' as const, reason: 'expired', sentence: 'This proposal expired before anyone approved it.' }
      : readinessOf(p.status, unvalidated, gateReason, (p.compileResult?.message as string | undefined) ?? null);
    return {
      id: p.id, kind: p.kind, scope: p.scope, status: p.status, gateOutcome: p.gateOutcome, readiness, reason, sentence,
      unvalidated, expired, expiresAt: p.expiresAt, seed: p.seed, target: p.target, targetVersions: p.targetVersions,
      payload: p.payload, rendering, compileResult: p.compileResult, gateDetail: p.gateDetail,
      provenance: {
        source: p.source, emitterKind: p.emitterKind, emitterVersion: p.emitterVersion, modelId: p.modelId, modelVersion: p.modelVersion,
        recommendationId: p.recommendationId, evidenceBundleId: p.evidenceBundleId, evidenceHash: p.evidenceHash,
        proposalHash: p.proposalHash, proposedBy: p.proposedBy, proposedAt: p.createdAt,
      },
      approval: p.approvedBy && p.approvedAt ? { by: p.approvedBy, at: p.approvedAt } : null,
      rejection: p.rejectedBy && p.rejectedAt ? { by: p.rejectedBy, at: p.rejectedAt, reason: p.rejectionReason } : null,
      materialisedRef: p.materialisedRef,
    };
  }

  private ctx(scope: RequestScope, proposalScope: ProposalScope, m: EntityManager, at: Date): EmitContext {
    return { scope, proposalScope, m, at };
  }

  private byKey(m: EntityManager, tenantId: string, key: string) {
    return m.getRepository(ArtifactProposal).findOne({ where: { tenantId, idempotencyKey: key } });
  }

  private async find(m: EntityManager, scope: RequestScope, id: string): Promise<ArtifactProposal> {
    const p = UUID.test(id) ? await m.getRepository(ArtifactProposal).findOne({ where: { tenantId: scope.tenantId, id } }) : null;
    if (!p) throw new NotFoundException('No such proposal in this account.');
    return p;
  }

  private async locked(m: EntityManager, scope: RequestScope, id: string): Promise<ArtifactProposal> {
    if (!UUID.test(id)) throw new NotFoundException('No such proposal in this account.');
    const p = await m.getRepository(ArtifactProposal).createQueryBuilder('p')
      .where('p.id = :id AND p.tenant_id = :t', { id, t: scope.tenantId })
      .setLock('pessimistic_write')
      .getOne();
    if (!p) throw new NotFoundException('No such proposal in this account.');
    return p;
  }
}

/** §7: never a green badge for something nobody may switch on, and "not replayed" is not "found nothing". */
function readinessOf(
  status: ProposalStatus, unvalidated: boolean, gateReason: string | null, compileMessage: string | null,
): { readiness: Readiness; reason: string | null; sentence: string } {
  switch (status) {
    case 'proposed':
    case 'compiled':
      return { readiness: 'pending', reason: 'not_gated', sentence: 'Not replayed yet. A replay that has not run is not one that found nothing.' };
    case 'compile_refused':
      return { readiness: 'blocked', reason: 'compile_refused', sentence: compileMessage ?? 'The compiler refused it.' };
    case 'gate_refused':
      return { readiness: 'blocked', reason: 'gate_refused', sentence: gateReason ?? 'The gate refused it.' };
    case 'rejected':
      return { readiness: 'blocked', reason: 'rejected', sentence: 'Rejected.' };
    case 'expired':
      return { readiness: 'blocked', reason: 'expired', sentence: 'This proposal expired before anyone approved it.' };
    default:
      if (unvalidated) {
        return {
          readiness: 'blocked', reason: 'insufficient_history',
          sentence: `Unvalidated: ${gateReason ?? 'there was not enough history to replay it'} `
            + 'It can be approved, but anything it materialises stays switched off until someone chooses to enable it.',
        };
      }
      return status === 'draft_ready'
        ? { readiness: 'ready', reason: null, sentence: 'Ready for approval.' }
        : { readiness: 'ready', reason: null, sentence: status === 'materialised' ? 'Approved and materialised.' : 'Approved.' };
  }
}
