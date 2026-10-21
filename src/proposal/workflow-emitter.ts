import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { can } from '../auth/capabilities';
import { RequestScope } from '../auth/types/request-scope';
import { ClientEquipmentClass } from '../client-catalog/entities/client-equipment-class.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { SignalBindingVersion } from '../signal-binding/entities/signal-binding-version.entity';
import { compileWorkflow, WorkflowSpec, WorkflowSpecError } from '../workflow/workflow-spec';
import { AssembledSource, WorkflowService } from '../workflow/workflow.service';
import {
  ArtifactEmitter, CompileOutcome, EmitContext, EmitResult, MaterialiseContext, MaterialisedRef, ReplayPlan, ReplayRule,
} from './emitter';

export interface WorkflowSeed {
  target: { appliesTo: 'equipment'; sourceSystem: string; externalId: string }
        | { appliesTo: 'plant'; plantId: string }
        | { appliesTo: 'equipment-class'; equipmentClassSlug: string };
  intent: 'watch-failure-mode' | 'combine-templates';
  failureModeCode?: string;
  alertTemplateSlugs?: string[];
  combine?: 'allOf' | 'anyOf';
  name?: string;
  slug?: string;
}

/**
 * The workflow emitter (task QGEN3, D25-D28, D34).
 *
 * Plugs QWF1's deterministic assembly and compiler into QGEN1's proposal substrate and replay harness.
 * Operates on closed vocabularies: registered node types, bound signals, and published alert templates.
 * Prediction has no emitter (D26); conditions are parameter sets, never arbitrary code or open text (D34).
 */
@Injectable()
export class WorkflowEmitter implements ArtifactEmitter<'workflow'> {
  readonly kind = 'workflow' as const;
  readonly version = '1.0.0';

  constructor(
    private readonly ds: DataSource,
    private readonly workflows: WorkflowService,
  ) {}

  async emit(seedRaw: Record<string, unknown>, ctx: EmitContext): Promise<EmitResult> {
    const seed = seedRaw as unknown as WorkflowSeed;

    if ((seed.intent as string) === 'prediction' || (seed as any).prediction) {
      throw new BadRequestException('Prediction has no emitter: no value about the future may come from a generated artifact (D26).');
    }

    if (seed.intent !== 'watch-failure-mode' && seed.intent !== 'combine-templates') {
      throw new BadRequestException(`Unknown workflow intent "${String(seed.intent)}".`);
    }

    if (!seed.target || seed.target.appliesTo !== 'equipment') {
      throw new BadRequestException('Target scope must be "equipment": class and plant targets are not yet enabled for generation (QGEN3 question 4).');
    }

    const eqTarget = seed.target as { appliesTo: 'equipment'; sourceSystem: string; externalId: string };
    const eq = await ctx.m.getRepository(EquipmentProfile).findOne({
      where: { tenantId: ctx.scope.tenantId, sourceSystem: eqTarget.sourceSystem, externalId: eqTarget.externalId },
    });
    if (!eq) {
      throw new BadRequestException(`Equipment ${eqTarget.sourceSystem}:${eqTarget.externalId} not found.`);
    }

    const assembled = await this.workflows.assembleIn(ctx.m, ctx.scope, {
      target: seed.target,
      failureModeCode: seed.failureModeCode,
      alertTemplateSlugs: seed.alertTemplateSlugs,
      combine: seed.combine,
    });

    if (assembled.unresolved.length > 0) {
      return {
        status: 'needs_input',
        missing: assembled.unresolved.map((u) => ({
          field: u.signal ?? u.templateSlug ?? 'target',
          reason: u.reason ?? 'unresolved',
          detail: u.detail,
        })),
      };
    }

    // Check bound signals: every ReadSignal node must name a signal bound on this equipment
    const readSignals = (assembled.spec.nodes ?? [])
      .filter((n) => n.type === 'ReadSignal')
      .map((n) => (n.params as { signal: string }).signal);

    const activeBindings = readSignals.length
      ? await ctx.m.getRepository(SignalBindingVersion).find({
          where: {
            tenantId: ctx.scope.tenantId,
            sourceSystem: eqTarget.sourceSystem,
            externalId: eqTarget.externalId,
            signalKey: In(readSignals),
            status: 'active',
            validTo: IsNull(),
            isPrimary: true,
          },
        })
      : [];

    const boundKeys = new Set(activeBindings.map((b) => b.signalKey));
    const unbound = readSignals.filter((s) => !boundKeys.has(s));
    if (unbound.length > 0) {
      return {
        status: 'needs_input',
        missing: unbound.map((s) => ({
          field: `signals.${s}`,
          reason: 'signal_unbound',
          detail: `Signal "${s}" is declared on the class but not bound on equipment ${eqTarget.sourceSystem}:${eqTarget.externalId}.`,
        })),
      };
    }

    // Gather target_versions
    let classCopies: { slug: string; templateVersion: number | null; templateChecksum: string | null }[] = [];
    if (eq.equipmentClassSlug) {
      const cls = await ctx.m.getRepository(ClientEquipmentClass).findOne({
        where: { tenantId: ctx.scope.tenantId, slug: eq.equipmentClassSlug },
      });
      if (cls) {
        classCopies = [{ slug: cls.slug, templateVersion: cls.templateVersion, templateChecksum: cls.templateChecksum }];
      }
    }

    const bindings = activeBindings.map((b) => ({
      id: b.id,
      signalKey: b.signalKey,
      sourceSystem: b.sourceSystem,
      externalId: b.externalId,
    }));

    const alertTemplates = (assembled.sources as AssembledSource[]).map((s) => ({
      ruleId: s.ruleId,
      templateSlug: s.templateSlug,
      templateVersion: s.templateVersion,
      templateChecksum: s.templateChecksum,
    }));

    const targetVersions = { classCopies, bindings, alertTemplates };

    return {
      status: 'proposed',
      payload: {
        spec: assembled.spec,
        sources: assembled.sources,
        name: seed.name ?? null,
        slug: seed.slug ?? null,
      },
      target: seed.target,
      targetVersions,
    };
  }

  async compile(payload: Record<string, unknown>, ctx: EmitContext): Promise<CompileOutcome> {
    const spec = payload.spec as WorkflowSpec | undefined;
    if (!spec) return { ok: false, message: 'Payload carries no workflow spec.' };

    if ((spec.kind as string) === 'agent') {
      return { ok: false, message: 'Agent workflows are not supported (D16).' };
    }

    // Parameter type and extraneous property schema check
    for (const node of spec.nodes ?? []) {
      if (node.type === 'Threshold') {
        const p = node.params as Record<string, unknown>;
        if (p.max !== undefined && typeof p.max !== 'number') {
          return { ok: false, message: `Node "${node.id}": parameter "max" must be numeric, got ${typeof p.max}.` };
        }
        if (p.min !== undefined && typeof p.min !== 'number') {
          return { ok: false, message: `Node "${node.id}": parameter "min" must be numeric, got ${typeof p.min}.` };
        }
        const allowed = new Set(['min', 'max', 'lookbackReadings', 'requiredBreaches']);
        const extras = Object.keys(p).filter((k) => !allowed.has(k));
        if (extras.length > 0) {
          return { ok: false, message: `Node "${node.id}": unknown parameter "${extras[0]}".` };
        }
      }
    }

    try {
      const compiled = compileWorkflow(spec);
      const planned = await this.workflows.compileSpec(ctx.m, ctx.scope, spec, 'proposed-wf', ctx.at);

      const machines = spec.scope.appliesTo === 'equipment' && spec.scope.sourceSystem && spec.scope.externalId
        ? [{ sourceSystem: spec.scope.sourceSystem, externalId: spec.scope.externalId }]
        : [];

      const replay: ReplayPlan = {
        compilerVersion: 'qwf1',
        machines,
        rules: compiled.rules.map((r) => ({
          name: r.name,
          trigger: r.trigger,
          params: r.params,
          signals: r.signals,
        })),
      };

      return {
        ok: true,
        result: {
          graphHash: planned.graphHash,
          compilerVersion: 'qwf1',
          rules: planned.rules.map((r) => ({ slug: r.slug, name: r.name, rendering: r.rendering })),
        },
        replay,
      };
    } catch (err) {
      if (err instanceof WorkflowSpecError) return { ok: false, message: err.message };
      return { ok: false, message: (err as Error).message };
    }
  }

  async render(payload: Record<string, unknown>, ctx: { scope: RequestScope; m: EntityManager }): Promise<string[]> {
    const spec = payload.spec as WorkflowSpec | undefined;
    if (!spec) return [];
    return this.workflows.renderSpec(ctx.m, ctx.scope, spec);
  }

  async materialise(
    payload: Record<string, unknown>,
    ctx: MaterialiseContext,
    m: EntityManager,
  ): Promise<MaterialisedRef> {
    if (!can(ctx.scope, 'alert.author')) {
      throw new ForbiddenException('Materialising an alert workflow needs alert.author.');
    }

    const spec = payload.spec as WorkflowSpec;
    const slug = (payload.slug as string) || `gen-${ctx.proposal.id.slice(0, 8)}`;
    const name = (payload.name as string) || `Generated Alert ${ctx.proposal.id.slice(0, 8)}`;

    const def = await this.workflows.createIn(
      m,
      ctx.scope,
      { slug, name, description: 'Generated workflow proposal', spec },
      { source: 'generated', proposalId: ctx.proposal.id },
    );

    const published = await this.workflows.publishIn(
      m,
      ctx.scope,
      def.id,
      1,
      ctx.at,
      { enabled: !ctx.unvalidated },
    );

    return {
      workflowId: def.id,
      version: published.version,
      ruleIds: published.rules.map((r) => r.id),
    };
  }
}
