import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AlertParams, AlertTrigger } from '../alert/services/alert-rules';
import { RequestScope } from '../auth/types/request-scope';
import { GateOutcome, PROPOSAL_KINDS, ProposalKind, ProposalScope } from './proposal-kinds';

/**
 * What a proposal was built against, so approval can refuse one whose ground moved
 * (shared contract §5: "rechecks scope, versions and evidence freshness"). Closed: the
 * substrate rechecks every key it knows and refuses a proposal carrying one it does not,
 * because a version nobody rechecks is a version that was never pinned.
 */
export interface TargetVersions {
  /** The tenant's class copies read, as copied. */
  classCopies?: { slug: string; templateVersion: number | null; templateChecksum: string | null }[];
  /** The binding version in force for each signal read. A rebind closes it. */
  bindings?: { id: string; signalKey: string; sourceSystem: string; externalId: string }[];
  /** The tenant's copied alert templates read. */
  alertTemplates?: { ruleId: string; templateSlug: string; templateVersion: number | null; templateChecksum: string | null }[];
}
export const TARGET_VERSION_KEYS: readonly (keyof TargetVersions)[] = ['classCopies', 'bindings', 'alertTemplates'];

export interface EmitContext {
  scope: RequestScope;
  /** Where the proposal will be routed (D27). */
  proposalScope: ProposalScope;
  m: EntityManager;
  at: Date;
}

export type EmitResult =
  | {
    status: 'proposed';
    /** The exact typed artifact. Stored byte for byte; never edited afterwards. */
    payload: Record<string, unknown>;
    target: Record<string, unknown>;
    targetVersions: TargetVersions;
    /** Question 5: null for selection-seeded proposals; set once an engine seeds them. */
    recommendationId?: string | null;
    evidenceBundleId?: string | null;
    evidenceHash?: string | null;
    /** Question 4: only when a model contributed. */
    modelId?: string | null;
    modelVersion?: string | null;
  }
  | { status: 'needs_input'; missing: { field: string; reason: string; detail: string }[] };

/** One rule a firing kind would write, as the replay evaluates it. */
export interface ReplayRule {
  name: string;
  trigger: AlertTrigger;
  params: AlertParams;
  /** Signals the rule reads; the history check is per signal. */
  signals: string[];
}

/** What to replay, from the kind's own compiler: never re-derived by the substrate. */
export interface ReplayPlan {
  compilerVersion: string;
  machines: { sourceSystem: string; externalId: string }[];
  rules: ReplayRule[];
}

export type CompileOutcome =
  | {
    ok: true;
    /** Stored as `compile_result`: what would be written, in the compiler's own terms. */
    result: Record<string, unknown>;
    /** Required for a kind that fires; ignored for one that does not. */
    replay?: ReplayPlan;
  }
  /** The compiler's own message, stored as written. Never retried or repaired here. */
  | { ok: false; message: string };

/** Deterministic checks a non-firing kind may add (QGEN2). A refusal names its reason. */
export interface KindChecks {
  refuse?: string;
  detail: Record<string, unknown>;
}

export interface MaterialiseContext {
  scope: RequestScope;
  at: Date;
  proposal: { id: string; scope: ProposalScope; gateOutcome: GateOutcome; targetVersions: TargetVersions };
  /**
   * True when the gate could not validate the draft (`insufficient_history`). A firing
   * kind writes its rules switched off; the database refuses them otherwise (D28).
   */
  unvalidated: boolean;
}

export interface MaterialisedRef {
  [key: string]: unknown;
}

/**
 * A typed emitter (D25): one per kind, seeded from a person's selection, never given an
 * open request. Emitters plug in; the substrate owns order, recording and refusal.
 */
export interface ArtifactEmitter<K extends ProposalKind = ProposalKind> {
  readonly kind: K;
  readonly version: string;
  emit(seed: Record<string, unknown>, ctx: EmitContext): Promise<EmitResult>;
  /** Delegates to QCE1 (KPI) or QWF1 (workflow); dry-run, writes nothing. */
  compile(payload: Record<string, unknown>, ctx: EmitContext): Promise<CompileOutcome>;
  checks?(payload: Record<string, unknown>, compiled: Record<string, unknown>, ctx: EmitContext): Promise<KindChecks>;
  /** Plain English, deterministic: what the approver reads. */
  render(payload: Record<string, unknown>, ctx: { scope: RequestScope; m: EntityManager }): Promise<string[]>;
  /**
   * Writes the artifact through the kind's normal service, inside the approval's
   * transaction (G09): a generated artifact and a hand-made one meet the same checks.
   */
  materialise(payload: Record<string, unknown>, ctx: MaterialiseContext, m: EntityManager): Promise<MaterialisedRef>;
}

/**
 * The closed registry, keyed by kind — the same shape as the operator and executor
 * registries. An emitter registers once; a second for the same kind, or one for a kind
 * that does not exist, is refused at registration rather than discovered at propose.
 */
@Injectable()
export class EmitterRegistry {
  private readonly byKind = new Map<ProposalKind, ArtifactEmitter>();

  register(emitter: ArtifactEmitter): void {
    if (!(PROPOSAL_KINDS as readonly string[]).includes(emitter.kind)) {
      throw new Error(`"${String(emitter.kind)}" is not a proposal kind; nothing may emit it.`);
    }
    if (this.byKind.has(emitter.kind)) {
      throw new Error(`An emitter for "${emitter.kind}" is already registered; a kind has exactly one.`);
    }
    this.byKind.set(emitter.kind, emitter);
  }

  get(kind: ProposalKind): ArtifactEmitter | null {
    return this.byKind.get(kind) ?? null;
  }

  /** Kinds with no emitter yet. QGEN2 and QGEN3 each remove one. */
  missing(): ProposalKind[] {
    return PROPOSAL_KINDS.filter((k) => !this.byKind.has(k));
  }
}
