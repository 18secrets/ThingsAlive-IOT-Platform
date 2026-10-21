import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull, Not } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { AlertRule } from '../alert/entities/alert-rule.entity';
import { describeRule, plainSignalName, SignalNamer } from '../alert/services/alert-rule-render';
import { ruleCoversMachine } from '../alert/services/alert.service';
import { ChainOriginParams, PredictionSeverityParams, SignalThresholdParams } from '../alert/services/alert-rules';
import { FuelLossParams } from '../alert/services/fuel-loss';
import { ClientEquipmentClassFailureMode } from '../client-catalog/entities/client-equipment-class-failure-mode.entity';
import { ClientEquipmentClass } from '../client-catalog/entities/client-equipment-class.entity';
import { EquipmentClassSensorRequirement } from '../catalog/entities/equipment-class-sensor-requirement.entity';
import { CLIENT_SOURCE_SYSTEM, EquipmentProfile } from '../equipment/equipment-profile.entity';
import { TelemetryWindowReader } from '../kpi/services/telemetry-window-reader';
import { tenantStaleAfterSeconds } from '../parameters/services/parameter-resolution';
import { withTenantSession } from '../scope/tenant-session';
import { bindingSegments, overlapping } from '../signal-binding/services/signal-binding.service';
import { classifyFreshness, resolveStaleAfterSeconds } from '../signal-binding/services/signal-freshness';
import { WorkflowDefinition } from './entities/workflow-definition.entity';
import { WorkflowLayout } from './entities/workflow-layout.entity';
import { WorkflowVersion } from './entities/workflow-version.entity';
import {
  CompiledRule, CompiledWorkflow, compileWorkflow, WorkflowNode, WorkflowScope, WorkflowSpec, WorkflowSpecError,
} from './workflow-spec';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export type LeafReadiness = 'ready' | 'not_configured' | 'blocked';

export interface MachineReadiness {
  machine: { sourceSystem: string; externalId: string; name: string | null };
  state: LeafReadiness;
  signals: { signal: string; state: LeafReadiness; reason: 'unbound' | 'stale' | 'no_readings' | null }[];
}

export interface PlannedRule {
  slug: string;
  name: string;
  trigger: CompiledRule['trigger'];
  params: CompiledRule['params'];
  severity: CompiledRule['severity'];
  description: string | null;
  rendering: string;
}

export interface CompileResult {
  graphHash: string;
  rules: PlannedRule[];
  rendering: string[];
  readiness: MachineReadiness[];
  /** Null when publish would go ahead; otherwise why it would be refused. */
  publishRefusal: string | null;
}

export interface AssembleInput {
  target: WorkflowScope;
  failureModeCode?: string;
  alertTemplateSlugs?: string[];
  combine?: 'allOf' | 'anyOf';
}

/**
 * Where a condition node's parameters came from: the account's copy of a published
 * alert template, pinned by version. A generated workflow records every one, so each
 * threshold it materialises traces to a template version rather than to its author.
 */
export interface AssembledSource {
  nodeId: string;
  ruleId: string;
  templateSlug: string;
  templateVersion: number | null;
  templateChecksum: string | null;
  signal: string | null;
}

export interface Unresolved {
  signal?: string;
  templateSlug?: string;
  reason: 'no_copied_template' | 'template_not_copied' | 'class_unknown';
  detail: string;
}

/**
 * Workflows (task QWF1): store, validate, compile, publish.
 *
 * The graph is the only thing anyone edits. Publishing compiles it into `alert_rule`
 * rows the shift runner already evaluates (D16) and marks them as the compiler's, so
 * the rules and the graph cannot drift; the plain-English reading is rendered from the
 * compiled rules, so it describes what runs, not what was drawn.
 */
@Injectable()
export class WorkflowService {
  private readonly reader = new TelemetryWindowReader();

  constructor(private readonly ds: DataSource) {}

  // ---------------------------------------------------------------- reading

  async list(scope: RequestScope) {
    return withTenantSession(this.ds, scope, async (m) => {
      const defs = await m.getRepository(WorkflowDefinition).find({ where: { tenantId: scope.tenantId }, order: { slug: 'ASC' } });
      return Promise.all(defs.map((d) => this.describe(m, scope, d)));
    });
  }

  async get(scope: RequestScope, id: string) {
    return withTenantSession(this.ds, scope, async (m) => this.describe(m, scope, await this.definition(m, scope, id)));
  }

  private async describe(m: EntityManager, scope: RequestScope, def: WorkflowDefinition) {
    const versions = await m.getRepository(WorkflowVersion).find({
      where: { tenantId: scope.tenantId, workflowId: def.id }, order: { version: 'ASC' },
    });
    const rules = await m.getRepository(AlertRule).find({
      where: { tenantId: scope.tenantId, compiledFromWorkflowId: def.id }, order: { slug: 'ASC' },
    });
    const layouts = versions.length ? await m.getRepository(WorkflowLayout).find({
      where: { tenantId: scope.tenantId, workflowVersionId: In(versions.map((v) => v.id)) },
    }) : [];
    const namer = await this.namerFor(m, scope, versions.at(-1)?.spec.scope);
    return {
      ...def,
      versions: versions.map((v) => {
        const compiled = safeCompile(v.spec);
        const own = rules.filter((r) => r.compiledFromVersionId === v.id);
        return {
          id: v.id, version: v.version, status: v.status, source: v.source, graphHash: v.graphHash,
          publishedAt: v.publishedAt, publishedBy: v.publishedBy, spec: v.spec,
          layout: layouts.find((l) => l.workflowVersionId === v.id)?.positions ?? {},
          rendering: compiled ? compiled.rules.map((r) => describeRule(r, namer)) : [],
          // Which of its rules are off (D43 Q7): one switched off at 3 a.m. stays visible here.
          rules: own.map((r) => ({ id: r.id, slug: r.slug, name: r.name, enabled: r.enabled })),
        };
      }),
    };
  }

  // ---------------------------------------------------------------- writing drafts

  async create(
    scope: RequestScope, input: { slug: string; name: string; description?: string | null; spec: WorkflowSpec },
  ) {
    return withTenantSession(this.ds, scope, (m) => this.createIn(m, scope, input));
  }

  /**
   * `create`, inside a transaction the caller already holds. A generated workflow
   * (QGEN3) is created here inside the proposal's approval, so it meets the same checks
   * as one a person draws and is written or not together with the approval.
   */
  async createIn(
    m: EntityManager, scope: RequestScope,
    input: { slug: string; name: string; description?: string | null; spec: WorkflowSpec },
    provenance: { source: 'manual' | 'generated'; proposalId: string | null } = { source: 'manual', proposalId: null },
  ) {
    if (!SLUG_PATTERN.test(input.slug ?? '')) throw new BadRequestException('A workflow needs a slug of lower-case letters, digits and hyphens.');
    if (!input.name?.trim()) throw new BadRequestException('A workflow needs a name.');
    {
      const compiled = await this.validate(m, scope, input.spec);
      const defs = m.getRepository(WorkflowDefinition);
      if (await defs.findOne({ where: { tenantId: scope.tenantId, slug: input.slug } })) {
        throw new ConflictException(`A workflow called "${input.slug}" already exists.`);
      }
      const def = await defs.save(defs.create({
        tenantId: scope.tenantId, slug: input.slug, name: input.name.trim(), description: input.description ?? null,
        kind: (input.spec.kind ?? 'alert') as any, createdBy: scope.userId,
      }));
      const versions = m.getRepository(WorkflowVersion);
      await versions.save(versions.create({
        tenantId: scope.tenantId, workflowId: def.id, version: 1, spec: input.spec, graphHash: compiled.graphHash,
        status: 'draft', source: provenance.source, proposalId: provenance.proposalId, createdBy: scope.userId,
      }));
      return this.describe(m, scope, def);
    }
  }

  async replaceSpec(scope: RequestScope, id: string, version: number, spec: WorkflowSpec) {
    return withTenantSession(this.ds, scope, async (m) => {
      const def = await this.definition(m, scope, id);
      const v = await this.version(m, scope, def, version);
      if (v.status !== 'draft') throw new ConflictException(`Version ${version} is ${v.status}; only a draft can change. Start a new version.`);
      const compiled = await this.validate(m, scope, spec);
      await m.getRepository(WorkflowVersion).update({ id: v.id }, { spec, graphHash: compiled.graphHash });
      return this.describe(m, scope, def);
    });
  }

  /** Positions only. Never touches the spec, the hash or a rule. */
  async setLayout(scope: RequestScope, id: string, version: number, positions: Record<string, unknown>) {
    return withTenantSession(this.ds, scope, async (m) => {
      const def = await this.definition(m, scope, id);
      const v = await this.version(m, scope, def, version);
      await m.getRepository(WorkflowLayout).save({ workflowVersionId: v.id, tenantId: scope.tenantId, positions });
      return { workflowVersionId: v.id, graphHash: v.graphHash, positions };
    });
  }

  /** A new draft, copied from the published version (or the newest one). */
  async newVersion(scope: RequestScope, id: string) {
    return withTenantSession(this.ds, scope, async (m) => {
      const def = await this.definition(m, scope, id, true);
      const versions = await m.getRepository(WorkflowVersion).find({
        where: { tenantId: scope.tenantId, workflowId: def.id }, order: { version: 'DESC' },
      });
      const draft = versions.find((v) => v.status === 'draft');
      if (draft) throw new ConflictException(`Version ${draft.version} is already a draft; edit that one.`);
      const from = versions.find((v) => v.status === 'published') ?? versions[0];
      const repo = m.getRepository(WorkflowVersion);
      await repo.save(repo.create({
        tenantId: scope.tenantId, workflowId: def.id, version: (versions[0]?.version ?? 0) + 1, spec: from.spec,
        graphHash: from.graphHash, status: 'draft', source: 'manual', proposalId: null, createdBy: scope.userId,
      }));
      return this.describe(m, scope, def);
    });
  }

  // ---------------------------------------------------------------- compile and publish

  /** Dry run: what publish would write, read back in words, and whether each machine can fire. */
  async compile(scope: RequestScope, id: string, version: number, at = new Date()): Promise<CompileResult> {
    return withTenantSession(this.ds, scope, async (m) => {
      const def = await this.definition(m, scope, id);
      const v = await this.version(m, scope, def, version);
      return this.plan(m, scope, def, v, at);
    });
  }

  /**
   * The dry run for a spec that is not stored yet: what publish would write and whether
   * each machine can fire. QGEN3's compile step, so a generated draft is judged by the
   * same plan its publish will use.
   */
  async compileSpec(m: EntityManager, scope: RequestScope, spec: WorkflowSpec, slugBase: string, at = new Date()): Promise<CompileResult> {
    return this.planSpec(m, scope, spec, slugBase, at);
  }

  /** The plain-English reading of a spec, in the words the workflow screens use. */
  async renderSpec(m: EntityManager, scope: RequestScope, spec: WorkflowSpec): Promise<string[]> {
    const compiled = safeCompile(spec);
    if (!compiled) return [];
    const namer = await this.namerFor(m, scope, spec.scope);
    return compiled.rules.map((r) => describeRule(r, namer));
  }

  /**
   * Compile and write, in one transaction, under the workflow row's lock — the lesson
   * of the import batch: two overlapping publishes must not both supersede the old
   * version and both insert rules. Idempotent: a version already published returns its
   * rules and writes nothing.
   */
  async publish(scope: RequestScope, id: string, version: number, at = new Date()) {
    return withTenantSession(this.ds, scope, (m) => this.publishIn(m, scope, id, version, at));
  }

  /**
   * `publish`, inside a transaction the caller already holds, with the same lock. A
   * draft generated without enough history to replay publishes its rules switched off
   * (`enabled: false`, D28); the database refuses them on otherwise.
   */
  async publishIn(m: EntityManager, scope: RequestScope, id: string, version: number, at = new Date(), opts: { enabled?: boolean } = {}) {
    {
      const def = await this.definition(m, scope, id, true);
      const v = await this.version(m, scope, def, version);
      const rules = m.getRepository(AlertRule);
      if (v.status === 'published') {
        return { version: v.version, status: v.status, alreadyPublished: true,
          rules: await rules.find({ where: { tenantId: scope.tenantId, compiledFromVersionId: v.id }, order: { slug: 'ASC' } }) };
      }
      if (v.status !== 'draft') throw new ConflictException(`Version ${version} is ${v.status} and cannot be published.`);

      const plan = await this.plan(m, scope, def, v, at);
      if (plan.publishRefusal) throw new ConflictException({ message: plan.publishRefusal, readiness: plan.readiness });

      // The version before is switched off, not rewritten: alert events point at its
      // rules, and those rules keep saying what they said when they fired.
      const previous = await m.getRepository(WorkflowVersion).findOne({
        where: { tenantId: scope.tenantId, workflowId: def.id, status: 'published' },
      });
      if (previous) {
        await rules.update({ tenantId: scope.tenantId, compiledFromVersionId: previous.id }, { enabled: false, updatedBy: scope.userId });
        await m.getRepository(WorkflowVersion).update({ id: previous.id }, { status: 'superseded' });
      }
      const compiled = compileWorkflow(v.spec);
      const written = await rules.save(plan.rules.map((p) => rules.create({
        tenantId: scope.tenantId, slug: p.slug, name: p.name, description: p.description,
        trigger: p.trigger, params: p.params, severity: p.severity,
        appliesTo: compiled.scope.appliesTo, plantId: compiled.scope.plantId ?? null,
        sourceSystem: compiled.scope.sourceSystem ?? null, externalId: compiled.scope.externalId ?? null,
        equipmentClassSlug: compiled.scope.equipmentClassSlug ?? null,
        enabled: opts.enabled ?? true, compiledFromWorkflowId: def.id, compiledFromVersionId: v.id, graphHash: compiled.graphHash,
        createdBy: scope.userId, updatedBy: scope.userId,
      })));
      await m.getRepository(WorkflowVersion).update({ id: v.id }, { status: 'published', publishedBy: scope.userId, publishedAt: at });
      return { version: v.version, status: 'published', alreadyPublished: false, rules: written, readiness: plan.readiness };
    }
  }

  /** Every compiled rule off, and the published version retired. The rules stay, off. */
  async retire(scope: RequestScope, id: string) {
    return withTenantSession(this.ds, scope, async (m) => {
      const def = await this.definition(m, scope, id, true);
      await m.getRepository(AlertRule).update(
        { tenantId: scope.tenantId, compiledFromWorkflowId: def.id }, { enabled: false, updatedBy: scope.userId },
      );
      await m.getRepository(WorkflowVersion).update(
        { tenantId: scope.tenantId, workflowId: def.id, status: 'published' }, { status: 'retired' },
      );
      return this.describe(m, scope, def);
    });
  }

  // ---------------------------------------------------------------- assembly

  /**
   * Selections plus the library, to a spec (task QWF1 §5, D25): the deterministic half
   * of generation, usable by a person now and by QGEN3 later. Reads only this
   * account's own copies and writes nothing. A failure-mode signal with no copied
   * template is returned as unresolved — never given a threshold invented here (G07).
   */
  async assemble(scope: RequestScope, input: AssembleInput) {
    return withTenantSession(this.ds, scope, (m) => this.assembleIn(m, scope, input));
  }

  /** `assemble`, inside a transaction the caller already holds (QGEN3's emitter). */
  async assembleIn(m: EntityManager, scope: RequestScope, input: AssembleInput) {
    {
      const target = input.target;
      const unresolved: Unresolved[] = [];
      const classSlug = await this.classOf(m, scope, target);
      const copies = await m.getRepository(AlertRule).find({
        where: { tenantId: scope.tenantId, templateSlug: Not(IsNull()), compiledFromWorkflowId: IsNull() },
        order: { slug: 'ASC' },
      });

      const chosen: AlertRule[] = [];
      for (const slug of input.alertTemplateSlugs ?? []) {
        const copy = copies.find((c) => c.templateSlug === slug && c.trigger !== 'composite');
        if (copy) chosen.push(copy);
        else unresolved.push({ templateSlug: slug, reason: 'template_not_copied', detail: `No copy of alert template "${slug}" in this account.` });
      }

      let failureModeName: string | null = null;
      if (input.failureModeCode) {
        if (!classSlug) {
          unresolved.push({ reason: 'class_unknown', detail: 'A failure mode belongs to a class, and this target names none.' });
        } else {
          const mode = await m.getRepository(ClientEquipmentClassFailureMode).findOne({
            where: { tenantId: scope.tenantId, clientEquipmentClassSlug: classSlug, code: input.failureModeCode },
          });
          if (!mode) throw new NotFoundException(`No failure mode "${input.failureModeCode}" on class "${classSlug}" in this account.`);
          failureModeName = mode.name;
          for (const signal of mode.signals) {
            const copy = copies.find((c) => c.trigger === 'signal-threshold'
              && (c.params as SignalThresholdParams).signal === signal
              && (!c.equipmentClassSlug || c.equipmentClassSlug === classSlug));
            if (!copy) {
              unresolved.push({ signal, reason: 'no_copied_template',
                detail: `No copied threshold template watches "${signal}". Add one or drop the signal; no threshold is assumed.` });
            } else if (!chosen.includes(copy)) {
              chosen.push(copy);
            }
          }
        }
      }

      const nodes: WorkflowNode[] = [];
      const edges: { from: string; to: string }[] = [];
      const conditions = chosen.map((rule, i) => conditionNodes(rule, `c${i + 1}`, nodes, edges));
      if (conditions.length > 1 && input.combine) {
        const join = { id: 'combine', type: input.combine === 'allOf' ? 'AllOf' as const : 'AnyOf' as const };
        nodes.push(join, { id: 'notify', type: 'Notify', params: {
          name: failureModeName ?? `${chosen.length} conditions`, severity: chosen[0].severity,
        } });
        for (const c of conditions) edges.push({ from: c, to: 'combine' });
        edges.push({ from: 'combine', to: 'notify' });
      } else {
        chosen.forEach((rule, i) => {
          nodes.push({ id: `notify${i + 1}`, type: 'Notify', params: { name: rule.name, severity: rule.severity,
            ...(rule.description ? { description: rule.description } : {}) } });
          edges.push({ from: conditions[i], to: `notify${i + 1}` });
        });
      }
      const spec: WorkflowSpec = { kind: 'alert', scope: target, nodes, edges };
      const compiled = nodes.length ? safeCompile(spec) : null;
      const namer = await this.namerFor(m, scope, target);
      const sources: AssembledSource[] = chosen.map((rule, i) => ({
        nodeId: conditions[i], ruleId: rule.id, templateSlug: rule.templateSlug!, templateVersion: rule.templateVersion ?? null,
        templateChecksum: rule.templateChecksum ?? null,
        signal: rule.trigger === 'signal-threshold' ? (rule.params as SignalThresholdParams).signal : null,
      }));
      return { spec, rendering: compiled ? compiled.rules.map((r) => describeRule(r, namer)) : [], unresolved, sources };
    }
  }

  // ---------------------------------------------------------------- internals

  /** The spec, compiled, plus what only the database knows: the scope exists and its class declares each signal. */
  private async validate(m: EntityManager, scope: RequestScope, spec: WorkflowSpec): Promise<CompiledWorkflow> {
    let compiled: CompiledWorkflow;
    try {
      compiled = compileWorkflow(spec);
    } catch (err) {
      if (err instanceof WorkflowSpecError) throw new BadRequestException(err.message);
      throw err;
    }
    const machines = await this.covered(m, scope, compiled.scope);
    const classSlugs = compiled.scope.appliesTo === 'equipment-class'
      ? [compiled.scope.equipmentClassSlug!]
      : [...new Set(machines.map((p) => p.equipmentClassSlug).filter((s): s is string => !!s))];
    if (compiled.signals.length) {
      const classes = classSlugs.length ? await m.getRepository(ClientEquipmentClass).find({
        where: { tenantId: scope.tenantId, slug: In(classSlugs) },
      }) : [];
      const declared = new Set(classes.flatMap((c) => (c.expectedSignals ?? []).map((s) => s.signal)));
      const missing = compiled.signals.find((s) => !declared.has(s));
      if (missing) {
        throw new BadRequestException(
          `Signal "${missing}" is not declared by ${classSlugs.length ? `class ${classSlugs.map((c) => `"${c}"`).join(', ')}` : 'any class this workflow covers'}.`,
        );
      }
    }
    return compiled;
  }

  private async plan(
    m: EntityManager, scope: RequestScope, def: WorkflowDefinition, v: WorkflowVersion, at: Date,
  ): Promise<CompileResult> {
    return this.planSpec(m, scope, v.spec, `wf-${def.slug.slice(0, 40)}-v${v.version}`, at);
  }

  private async planSpec(m: EntityManager, scope: RequestScope, spec: WorkflowSpec, base: string, at: Date): Promise<CompileResult> {
    const compiled = await this.validate(m, scope, spec);
    const namer = await this.namerFor(m, scope, compiled.scope);
    const rules: PlannedRule[] = compiled.rules.map((r, i) => ({
      slug: `${base}-${i + 1}`, name: r.name, trigger: r.trigger, params: r.params, severity: r.severity,
      description: r.description, rendering: describeRule(r, namer),
    }));
    const machines = await this.covered(m, scope, compiled.scope);
    const signals = [...new Set(compiled.rules.flatMap((r) => r.signals))];
    const readiness = await Promise.all(machines.map((p) => this.machineReadiness(m, scope.tenantId, p, signals, at)));

    let publishRefusal: string | null = null;
    if (compiled.scope.appliesTo === 'equipment') {
      const unbound = readiness.flatMap((r) => r.signals).filter((s) => s.reason === 'unbound').map((s) => s.signal);
      if (unbound.length) {
        publishRefusal = `The machine has no binding for ${unbound.join(', ')} (unbound). A rule on a signal it does not `
          + 'have looks configured and never fires.';
      }
    } else if (!readiness.some((r) => r.state === 'ready')) {
      // D43 Q8: a site or class workflow publishes with its per-machine readiness listed,
      // and is refused only when nothing it covers could fire.
      publishRefusal = machines.length
        ? 'No machine this workflow covers is ready: every one is missing or not receiving a signal it reads.'
        : 'This workflow covers no machine in the account.';
    }
    return { graphHash: compiled.graphHash, rules, rendering: rules.map((r) => r.rendering), readiness, publishRefusal };
  }

  /** The machines a scope covers, by the engine's own rule (`ruleCoversMachine`). */
  private async covered(m: EntityManager, scope: RequestScope, s: WorkflowScope): Promise<EquipmentProfile[]> {
    if (s.appliesTo === 'equipment') {
      const one = await m.getRepository(EquipmentProfile).findOne({
        where: { tenantId: scope.tenantId, sourceSystem: s.sourceSystem!, externalId: s.externalId! },
      });
      // The reason alert.service gives: a rule pointing at a machine not here looks
      // configured and never fires.
      if (!one) throw new NotFoundException('No such machine in this account.');
      return [one];
    }
    const all = await m.getRepository(EquipmentProfile).find({ where: { tenantId: scope.tenantId, status: 'active' }, order: { externalId: 'ASC' } });
    const rule = {
      appliesTo: s.appliesTo, plantId: s.plantId ?? null, equipmentClassSlug: s.equipmentClassSlug ?? null,
      sourceSystem: s.sourceSystem ?? null, externalId: s.externalId ?? null,
    };
    return all.filter((p) => ruleCoversMachine(rule, p));
  }

  /**
   * Per machine, per signal: bound or not, and if bound whether readings are fresh —
   * the binding segments the KPI evaluator reads and the same freshness resolution
   * (tenant `stale_after_seconds`, then the class requirement, then the default), so a
   * signal cannot be ready here and stale on the machine page.
   */
  private async machineReadiness(
    m: EntityManager, tenantId: string, profile: EquipmentProfile, signals: string[], at: Date,
  ): Promise<MachineReadiness> {
    const ref = { sourceSystem: profile.sourceSystem, externalId: profile.externalId };
    const segments = await bindingSegments(m, tenantId, ref, signals, { by: 'signalKey', componentId: '' });
    const inForce = overlapping(segments, at, at);
    const latest = await this.reader.latestPerSignalInSegments(
      m, tenantId, inForce.map(({ signal, imei, from, to }) => ({ signal, imei, from, to })), at,
    );
    const tenantStale = signals.length ? await tenantStaleAfterSeconds(m, tenantId, profile, at) : null;
    const requirements = signals.length && profile.equipmentClassSlug && profile.classVersion
      ? await m.getRepository(EquipmentClassSensorRequirement).find({
        where: { classSlug: profile.equipmentClassSlug, classVersion: profile.classVersion, componentScope: '', measurementRole: In(signals) },
      }) : [];
    const out = signals.map((signal) => {
      if (!inForce.some((s) => s.signal === signal)) return { signal, state: 'not_configured' as const, reason: 'unbound' as const };
      const staleAfter = resolveStaleAfterSeconds(requirements.find((r) => r.measurementRole === signal) ?? null, tenantStale);
      const fresh = classifyFreshness(latest.get(signal) ?? null, at, staleAfter);
      return fresh === 'ready'
        ? { signal, state: 'ready' as const, reason: null }
        : { signal, state: 'blocked' as const, reason: fresh };
    });
    const state: LeafReadiness = out.some((s) => s.state === 'not_configured') ? 'not_configured'
      : out.some((s) => s.state === 'blocked') ? 'blocked' : 'ready';
    return { machine: { ...ref, name: profile.name }, state, signals: out };
  }

  /** Units for the sentences, from the class copies the scope reaches. */
  private async namerFor(m: EntityManager, scope: RequestScope, s: WorkflowScope | undefined): Promise<SignalNamer> {
    if (!s) return plainSignalName;
    const slug = await this.classOf(m, scope, s).catch(() => null);
    const classes = await m.getRepository(ClientEquipmentClass).find({
      where: slug ? { tenantId: scope.tenantId, slug } : { tenantId: scope.tenantId },
    });
    const units = new Map<string, string | null>();
    for (const c of classes) for (const e of c.expectedSignals ?? []) if (!units.has(e.signal)) units.set(e.signal, e.unit);
    return (signal) => ({ ...plainSignalName(signal), unit: units.get(signal) ?? null });
  }

  private async classOf(m: EntityManager, scope: RequestScope, s: WorkflowScope): Promise<string | null> {
    if (s?.appliesTo === 'equipment-class') return s.equipmentClassSlug ?? null;
    if (s?.appliesTo === 'equipment') {
      const p = await m.getRepository(EquipmentProfile).findOne({
        where: { tenantId: scope.tenantId, sourceSystem: s.sourceSystem ?? CLIENT_SOURCE_SYSTEM, externalId: s.externalId ?? '' },
      });
      return p?.equipmentClassSlug ?? null;
    }
    return null;
  }

  private async definition(m: EntityManager, scope: RequestScope, id: string, lock = false): Promise<WorkflowDefinition> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('No such workflow in this account.');
    const qb = m.getRepository(WorkflowDefinition).createQueryBuilder('w')
      .where('w.id = :id AND w.tenant_id = :t', { id, t: scope.tenantId });
    if (lock) qb.setLock('pessimistic_write');
    const def = await qb.getOne();
    if (!def) throw new NotFoundException('No such workflow in this account.');
    return def;
  }

  private async version(m: EntityManager, scope: RequestScope, def: WorkflowDefinition, version: number): Promise<WorkflowVersion> {
    const v = await m.getRepository(WorkflowVersion).findOne({ where: { tenantId: scope.tenantId, workflowId: def.id, version } });
    if (!v) throw new NotFoundException(`Workflow "${def.slug}" has no version ${version}.`);
    return v;
  }
}

function safeCompile(spec: WorkflowSpec): CompiledWorkflow | null {
  try { return compileWorkflow(spec); } catch { return null; }
}

/** The condition node(s) for one copied rule; returns the id of the node that feeds onward. */
function conditionNodes(
  rule: AlertRule, id: string, nodes: WorkflowNode[], edges: { from: string; to: string }[],
): string {
  switch (rule.trigger) {
    case 'signal-threshold': {
      const { signal, ...bounds } = rule.params as SignalThresholdParams;
      nodes.push({ id: `${id}-signal`, type: 'ReadSignal', params: { signal } }, { id, type: 'Threshold', params: { ...bounds } });
      edges.push({ from: `${id}-signal`, to: id });
      return id;
    }
    case 'prediction-severity':
      nodes.push({ id, type: 'PredictionSeverity', params: { ...(rule.params as PredictionSeverityParams) } });
      return id;
    case 'no-telemetry':
      nodes.push({ id, type: 'FreshnessGate', params: {} });
      return id;
    case 'fuel-loss':
      nodes.push({ id, type: 'FuelLoss', params: { ...(rule.params as FuelLossParams) } });
      return id;
    case 'chain-origin':
      nodes.push({ id, type: 'ChainOrigin', params: { ...(rule.params as ChainOriginParams) } });
      return id;
    default:
      throw new BadRequestException(`A copied rule of kind "${rule.trigger}" cannot be assembled.`);
  }
}
