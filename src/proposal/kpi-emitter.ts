import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import {
  FormulaAggregationWindow, FormulaChartType, FormulaComparisonBasis, FormulaKind,
  FormulaResultKind, FormulaTargetDirection,
} from '../catalog/entities/equipment-class-formula.entity';
import { NamedFormula } from '../catalog/entities/named-formula.entity';
import { compileFormula, ValueKind } from '../catalog/formula/formula-compiler';
import { checkDimensions, checkRolesBound, checkSuspiciousBindings, substituteExpression } from '../catalog/formula/named-formula-binding';
import { parseUnitString, unitsEqual } from '../catalog/formula/units';
import { ClientEquipmentClass } from '../client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../client-catalog/entities/client-formula.entity';
import { SensorRoleCapability } from '../device-catalog/entities/sensor-role-capability.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { KpiEvaluatorService } from '../kpi/services/kpi-evaluator.service';
import { KpiEnvelope } from '../kpi/types';
import {
  ArtifactEmitter, CompileOutcome, EmitContext, EmitResult, KindChecks, MaterialiseContext, MaterialisedRef,
} from './emitter';

export interface KpiSeed {
  target: { sourceSystem: string; externalId: string } | { clientEquipmentClassSlug: string };
  intent: 'bind-named-formula' | 'ratio-kpis';
  namedFormulaSlug?: string;
  formulaKeys?: [string, string] | string[];
  formulaKey?: string;
  bindings?: { role: string; signal: string }[];
  targetValue?: number | null;
  targetMin?: number | null;
  targetMax?: number | null;
  targetDirection?: FormulaTargetDirection;
  displayUnit?: string | null;
  displayFormat?: string;
  aggregationWindow?: FormulaAggregationWindow;
  comparisonBasis?: FormulaComparisonBasis;
  chartType?: FormulaChartType;
}

/**
 * The KPI / formula emitter (task QGEN2, D25-D33).
 *
 * Deterministic composition of client formulas from closed vocabularies:
 * - 'bind-named-formula': binds a published catalogue NamedFormula to class signals by measurement.
 * - 'ratio-kpis': derives a ratio from two existing sibling formulas on the class copy.
 *
 * Nothing the model or user writes is executed directly; everything is compiled by QCE1.
 */
@Injectable()
export class KpiEmitter implements ArtifactEmitter<'kpi'> {
  readonly kind = 'kpi' as const;
  readonly version = '1.0.0';

  constructor(
    private readonly ds: DataSource,
    private readonly kpiEvaluator: KpiEvaluatorService,
  ) {}

  async emit(seedRaw: Record<string, unknown>, ctx: EmitContext): Promise<EmitResult> {
    const seed = seedRaw as unknown as KpiSeed;

    if ((seed.intent as string) === 'prediction' || (seed as any).prediction) {
      throw new BadRequestException('Prediction has no emitter: no value about the future may come from a generated artifact (D26).');
    }

    if (seed.intent !== 'bind-named-formula' && seed.intent !== 'ratio-kpis') {
      throw new BadRequestException(`Unknown KPI intent "${String(seed.intent)}".`);
    }

    let classSlug: string;
    let targetEquipment: { sourceSystem: string; externalId: string } | null = null;

    if ('sourceSystem' in (seed.target ?? {}) && 'externalId' in (seed.target ?? {})) {
      const eqTarget = seed.target as { sourceSystem: string; externalId: string };
      targetEquipment = eqTarget;
      const eq = await ctx.m.getRepository(EquipmentProfile).findOne({
        where: { tenantId: ctx.scope.tenantId, sourceSystem: eqTarget.sourceSystem, externalId: eqTarget.externalId },
      });
      if (!eq) throw new BadRequestException(`Equipment ${eqTarget.sourceSystem}:${eqTarget.externalId} not found.`);
      if (!eq.equipmentClassSlug) throw new BadRequestException(`Equipment ${eqTarget.sourceSystem}:${eqTarget.externalId} has no assigned class.`);
      classSlug = eq.equipmentClassSlug;
    } else if ('clientEquipmentClassSlug' in (seed.target ?? {})) {
      classSlug = (seed.target as { clientEquipmentClassSlug: string }).clientEquipmentClassSlug;
    } else {
      throw new BadRequestException('Seed target must specify sourceSystem/externalId or clientEquipmentClassSlug.');
    }

    const cls = await ctx.m.getRepository(ClientEquipmentClass).findOne({
      where: { tenantId: ctx.scope.tenantId, slug: classSlug, status: 'active' },
    });
    if (!cls) throw new BadRequestException(`Client equipment class "${classSlug}" not found or inactive.`);

    const targetVersions = {
      classCopies: [{ slug: cls.slug, templateVersion: cls.templateVersion, templateChecksum: cls.templateChecksum }],
    };

    if (seed.intent === 'bind-named-formula') {
      if (!seed.namedFormulaSlug?.trim()) {
        return {
          status: 'needs_input',
          missing: [{ field: 'namedFormulaSlug', reason: 'missing', detail: 'A catalogue formula slug must be selected.' }],
        };
      }

      const named = await ctx.m.getRepository(NamedFormula).findOne({
        where: { slug: seed.namedFormulaSlug, status: 'published' },
        order: { version: 'DESC' },
      });
      if (!named) {
        throw new BadRequestException(`Named formula "${seed.namedFormulaSlug}" is not published or does not exist.`);
      }

      const expectedSignals = cls.expectedSignals ?? [];
      const signalUnits = new Map<string, string | null>(expectedSignals.map((s) => [s.signal, s.unit ?? null]));
      const signalNames = new Set(expectedSignals.map((s) => s.signal));

      const capabilities = expectedSignals.length
        ? await ctx.m.getRepository(SensorRoleCapability).find({
            where: { measurementRole: In(expectedSignals.map((s) => s.signal)) },
          })
        : [];
      const parameterKeysBySignal = new Map<string, string[]>();
      for (const cap of capabilities) {
        if (!cap.parameterKey) continue;
        const list = parameterKeysBySignal.get(cap.measurementRole) ?? [];
        list.push(cap.parameterKey);
        parameterKeysBySignal.set(cap.measurementRole, list);
      }

      const userBindings = new Map((seed.bindings ?? []).map((b) => [b.role, b.signal]));
      const finalBindings: { role: string; signal: string }[] = [];
      const missing: { field: string; reason: string; detail: string }[] = [];

      for (const role of named.inputs) {
        if (userBindings.has(role.role)) {
          const sig = userBindings.get(role.role)!;
          if (!signalNames.has(sig)) {
            missing.push({ field: `bindings.${role.role}`, reason: 'unknown_signal', detail: `Signal "${sig}" is not declared on class "${classSlug}".` });
            continue;
          }
          const mismatches = checkDimensions([role], [{ role: role.role, signal: sig }], signalUnits);
          if (mismatches.length) {
            throw new BadRequestException(
              `Role "${role.role}" expects "${mismatches[0].expectedDimension}" but is bound to "${mismatches[0].signal}" ("${mismatches[0].actualUnit}").`,
            );
          }
          const suspicious = checkSuspiciousBindings([role], [{ role: role.role, signal: sig }], parameterKeysBySignal);
          if (suspicious.length) {
            throw new BadRequestException(
              `Refused: role "${role.role}" expects one of [${suspicious[0].expectedParameters.join(', ')}] but "${suspicious[0].signal}" measures [${suspicious[0].boundParameterKeys.join(', ')}] (suspicious_binding).`,
            );
          }
          finalBindings.push({ role: role.role, signal: sig });
          continue;
        }

        const expectedUnit = parseUnitString(role.dimension);
        const unitCompatible = expectedSignals.filter((s) => unitsEqual(expectedUnit, parseUnitString(s.unit)));

        if (!role.expectedParameters || role.expectedParameters.length === 0) {
          if (unitCompatible.length === 0) {
            missing.push({
              field: `bindings.${role.role}`,
              reason: 'no_matching_signals',
              detail: `No signal with unit "${role.dimension}" exists on class "${classSlug}".`,
            });
          } else {
            missing.push({
              field: `bindings.${role.role}`,
              reason: 'disambiguation_needed',
              detail: `Role "${role.role}" has no measurement constraint; choose from unit-compatible signals: [${unitCompatible.map((s) => s.signal).join(', ')}].`,
            });
          }
          continue;
        }

        let matchesByMeasurement = unitCompatible.filter((s) => {
          const keys = parameterKeysBySignal.get(s.signal) ?? [];
          return keys.some((k) => role.expectedParameters!.includes(k)) || role.expectedParameters!.includes(s.signal);
        });

        if (matchesByMeasurement.length > 1) {
          const exact = matchesByMeasurement.filter((s) => s.signal === role.role);
          if (exact.length === 1) {
            matchesByMeasurement = exact;
          }
        }

        if (matchesByMeasurement.length === 0) {
          const activeDisagreements = unitCompatible.filter((s) => {
            const keys = parameterKeysBySignal.get(s.signal) ?? [];
            return keys.length > 0 && keys.every((k) => !role.expectedParameters!.includes(k));
          });
          if (activeDisagreements.length > 0 && activeDisagreements.length === unitCompatible.length) {
            throw new BadRequestException(
              `Refused: role "${role.role}" expects one of [${role.expectedParameters.join(', ')}] but unit-compatible signal(s) measure [${activeDisagreements.map((s) => `${s.signal}:${(parameterKeysBySignal.get(s.signal) ?? []).join(',')}`).join('; ')}] (suspicious_binding).`,
            );
          }
          missing.push({
            field: `bindings.${role.role}`,
            reason: 'no_matching_signals',
            detail: `No signal measuring [${role.expectedParameters.join(', ')}] exists on class "${classSlug}".`,
          });
        } else if (matchesByMeasurement.length > 1) {
          missing.push({
            field: `bindings.${role.role}`,
            reason: 'multiple_candidates',
            detail: `Role "${role.role}" matches multiple signals: [${matchesByMeasurement.map((s) => s.signal).join(', ')}].`,
          });
        } else {
          finalBindings.push({ role: role.role, signal: matchesByMeasurement[0].signal });
        }
      }

      if (missing.length > 0) {
        return { status: 'needs_input', missing };
      }

      checkRolesBound(named.inputs, finalBindings);
      const expression = substituteExpression(named.expression, finalBindings);
      const formulaKey = seed.formulaKey?.trim() || named.slug;

      const payload: Record<string, unknown> = {
        clientEquipmentClassSlug: classSlug,
        formulaKey,
        kind: 'physics',
        expression,
        namedFormulaSlug: named.slug,
        namedFormulaVersion: named.version,
        bindings: finalBindings,
        resultKind: null,
        displayUnit: seed.displayUnit ?? null,
        displayFormat: seed.displayFormat ?? 'number:1',
        targetValue: seed.targetValue ?? null,
        targetMin: seed.targetMin ?? null,
        targetMax: seed.targetMax ?? null,
        targetDirection: seed.targetDirection ?? 'none',
        comparisonBasis: seed.comparisonBasis ?? 'none',
        aggregationWindow: seed.aggregationWindow ?? 'shift',
        chartType: seed.chartType ?? 'none',
      };

      return {
        status: 'proposed',
        payload,
        target: targetEquipment ? { sourceSystem: targetEquipment.sourceSystem, externalId: targetEquipment.externalId } : { clientEquipmentClassSlug: classSlug },
        targetVersions,
      };
    }

    // seed.intent === 'ratio-kpis'
    const keys = seed.formulaKeys ?? [];
    if (keys.length < 2) {
      throw new BadRequestException('The "ratio-kpis" intent requires formulaKeys with [numerator, denominator].');
    }
    const [numKey, denKey] = keys;
    const siblings = await ctx.m.getRepository(ClientFormula).find({
      where: { tenantId: ctx.scope.tenantId, clientEquipmentClassSlug: classSlug, status: 'active' },
    });
    const siblingKeys = new Set(siblings.map((s) => s.formulaKey));
    const missing: { field: string; reason: string; detail: string }[] = [];
    if (!siblingKeys.has(numKey)) {
      missing.push({ field: 'formulaKeys', reason: 'formula_not_found', detail: `Numerator formula "${numKey}" does not exist on class "${classSlug}".` });
    }
    if (!siblingKeys.has(denKey)) {
      missing.push({ field: 'formulaKeys', reason: 'formula_not_found', detail: `Denominator formula "${denKey}" does not exist on class "${classSlug}".` });
    }
    if (missing.length > 0) {
      return { status: 'needs_input', missing };
    }

    const expression = `#${numKey} / #${denKey}`;
    const formulaKey = seed.formulaKey?.trim() || `${numKey}_to_${denKey}_ratio`;

    const payload: Record<string, unknown> = {
      clientEquipmentClassSlug: classSlug,
      formulaKey,
      kind: 'scalar',
      expression,
      namedFormulaSlug: null,
      namedFormulaVersion: null,
      bindings: [],
      resultKind: null,
      displayUnit: seed.displayUnit ?? null,
      displayFormat: seed.displayFormat ?? 'number:2',
      targetValue: seed.targetValue ?? null,
      targetMin: seed.targetMin ?? null,
      targetMax: seed.targetMax ?? null,
      targetDirection: seed.targetDirection ?? 'none',
      comparisonBasis: seed.comparisonBasis ?? 'none',
      aggregationWindow: seed.aggregationWindow ?? 'shift',
      chartType: seed.chartType ?? 'none',
    };

    return {
      status: 'proposed',
      payload,
      target: targetEquipment ? { sourceSystem: targetEquipment.sourceSystem, externalId: targetEquipment.externalId } : { clientEquipmentClassSlug: classSlug },
      targetVersions,
    };
  }

  async compile(payload: Record<string, unknown>, ctx: EmitContext): Promise<CompileOutcome> {
    if (
      'required_signals' in payload || 'requiredSignals' in payload ||
      'compiled_plan' in payload || 'compiledPlan' in payload
    ) {
      return {
        ok: false,
        message: 'A proposal payload may not declare required_signals or compiled_plan; those are derived by the compiler at materialisation.',
      };
    }

    const classSlug = payload.clientEquipmentClassSlug as string;
    const formulaKey = payload.formulaKey as string;
    const expression = payload.expression as string;

    await ctx.m.query(`SELECT set_config('ta.tenant_id', $1, true)`, [ctx.scope.tenantId]).catch(() => null);

    const cls = await ctx.m.getRepository(ClientEquipmentClass).findOne({
      where: { tenantId: ctx.scope.tenantId, slug: classSlug },
    });
    if (!cls) return { ok: false, message: `Class "${classSlug}" not found.` };

    const siblings = await ctx.m.getRepository(ClientFormula).find({
      where: { tenantId: ctx.scope.tenantId, clientEquipmentClassSlug: classSlug },
    });

    try {
      const compiled = compileFormula({
        classSlug: cls.slug,
        expectedSignals: cls.expectedSignals ?? [],
        formulaKey,
        expression,
        declaredResultKind: (payload.resultKind as ValueKind) ?? undefined,
        declaredDisplayUnit: (payload.displayUnit as string) ?? undefined,
        declaredChartType: (payload.chartType as FormulaChartType) ?? undefined,
        siblingFormulas: siblings.map((s) => ({
          formulaKey: s.formulaKey,
          expression: s.expression,
          declaredResultKind: (s.resultKind as ValueKind) ?? undefined,
          declaredDisplayUnit: s.displayUnit,
        })),
      });

      return {
        ok: true,
        result: {
          compiledPlan: compiled.plan,
          resultKind: compiled.resultKind,
          resultUnit: compiled.resultUnit,
          requiredSignals: compiled.requiredSignals,
          requiredParameters: compiled.requiredParameters,
        },
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async checks(
    payload: Record<string, unknown>,
    compiled: Record<string, unknown>,
    ctx: EmitContext,
  ): Promise<KindChecks> {
    const target = ctx.m ? (await ctx.m.query(
      `SELECT "target" FROM "artifact_proposal" WHERE "id" = $1`,
      [(ctx as any).proposalId],
    ).then((r: any[]) => r[0]?.target).catch(() => null)) : null;

    const eqTarget = (target?.sourceSystem && target?.externalId)
      ? target
      : (payload.target as { sourceSystem?: string; externalId?: string } | undefined);

    const sourceSystem = eqTarget?.sourceSystem;
    const externalId = eqTarget?.externalId;

    if (!sourceSystem || !externalId) {
      return { detail: { evaluated: false, note: 'No target equipment specified for informational evaluation.' } };
    }

    let envelope: KpiEnvelope | null = null;
    try {
      await this.ds.transaction(async (txEm) => {
        await txEm.query(`SET TRANSACTION READ ONLY`);
        await txEm.query(`SELECT set_config('ta.tenant_id', $1, true)`, [ctx.scope.tenantId]);

        const candidate = new ClientFormula();
        candidate.tenantId = ctx.scope.tenantId;
        candidate.clientEquipmentClassSlug = payload.clientEquipmentClassSlug as string;
        candidate.formulaKey = payload.formulaKey as string;
        candidate.kind = (payload.kind as FormulaKind) ?? 'physics';
        candidate.expression = payload.expression as string;
        candidate.compiledPlan = (compiled.compiledPlan as Record<string, unknown>) ?? null;
        candidate.resultKind = (compiled.resultKind as FormulaResultKind) ?? (payload.resultKind as FormulaResultKind) ?? null;
        candidate.resultUnit = (compiled.resultUnit as string) ?? null;
        candidate.requiredSignals = (compiled.requiredSignals as string[]) ?? [];
        candidate.requiredParameters = (compiled.requiredParameters as string[]) ?? [];
        candidate.aggregationWindow = (payload.aggregationWindow as FormulaAggregationWindow) ?? 'shift';

        envelope = await this.kpiEvaluator.evaluateCandidate(
          txEm, ctx.scope.tenantId, { sourceSystem, externalId }, candidate, ctx.at,
        );
      });
    } catch (err) {
      envelope = null;
    }

    return {
      detail: {
        evaluation: envelope ? {
          value: envelope.value,
          unit: envelope.unit,
          resultKind: envelope.resultKind,
          readiness: envelope.readiness,
          reason: envelope.reason,
          missingParameters: envelope.missingParameters,
          coverage: envelope.coverage,
        } : null,
      },
    };
  }

  async render(payload: Record<string, unknown>): Promise<string[]> {
    const lines: string[] = [];
    const key = payload.formulaKey as string;
    const kind = (payload.kind as string) ?? 'scalar';
    const displayUnit = payload.displayUnit ?? payload.resultUnit ?? '(inferred)';
    const format = (payload.displayFormat as string) ?? 'number:1';
    const window = (payload.aggregationWindow as string) ?? 'shift';

    if (payload.namedFormulaSlug) {
      const bindings = (payload.bindings as { role: string; signal: string }[]) ?? [];
      const bStr = bindings.map((b) => `${b.role}=${b.signal}`).join('; ');
      lines.push(`Computes "${key}" (${kind}) from catalogue formula "${payload.namedFormulaSlug}" v${payload.namedFormulaVersion ?? 1} bound as [${bStr}].`);
    } else {
      lines.push(`Computes "${key}" (${kind}) as "${payload.expression}".`);
    }

    lines.push(`Unit: ${displayUnit}, format: ${format}, window: ${window}.`);

    if (payload.targetDirection && payload.targetDirection !== 'none') {
      lines.push(`Target: ${payload.targetDirection} ${payload.targetValue ?? payload.targetMax ?? payload.targetMin ?? 'none'}.`);
    } else {
      lines.push('Target: none.');
    }

    return lines;
  }

  async materialise(
    payload: Record<string, unknown>,
    ctx: MaterialiseContext,
    m: EntityManager,
  ): Promise<MaterialisedRef> {
    const repo = m.getRepository(ClientFormula);
    const classSlug = payload.clientEquipmentClassSlug as string;
    const formulaKey = payload.formulaKey as string;

    const existing = await repo.findOne({
      where: { tenantId: ctx.scope.tenantId, clientEquipmentClassSlug: classSlug, formulaKey },
    });
    if (existing) {
      throw new ConflictException(`Formula "${formulaKey}" already exists on class "${classSlug}".`);
    }

    const cls = await m.getRepository(ClientEquipmentClass).findOne({
      where: { tenantId: ctx.scope.tenantId, slug: classSlug },
    });
    if (!cls) throw new NotFoundException(`Class "${classSlug}" not found.`);

    const siblings = await repo.find({
      where: { tenantId: ctx.scope.tenantId, clientEquipmentClassSlug: classSlug },
    });

    const compiled = compileFormula({
      classSlug: cls.slug,
      expectedSignals: cls.expectedSignals ?? [],
      formulaKey,
      expression: payload.expression as string,
      declaredResultKind: (payload.resultKind as ValueKind) ?? undefined,
      declaredDisplayUnit: (payload.displayUnit as string) ?? undefined,
      declaredChartType: (payload.chartType as FormulaChartType) ?? undefined,
      siblingFormulas: siblings.map((s) => ({
        formulaKey: s.formulaKey,
        expression: s.expression,
        declaredResultKind: (s.resultKind as ValueKind) ?? undefined,
        declaredDisplayUnit: s.displayUnit,
      })),
    });

    const formula = new ClientFormula();
    formula.tenantId = ctx.scope.tenantId;
    formula.clientEquipmentClassSlug = classSlug;
    formula.formulaKey = formulaKey;
    formula.kind = (payload.kind as FormulaKind) ?? 'physics';
    formula.expression = payload.expression as string;
    formula.compiledPlan = compiled.plan;
    formula.compiledAt = ctx.at;
    formula.compilerVersion = compiled.compilerVersion;
    formula.resultUnit = compiled.resultUnit ?? null;
    formula.requiredSignals = compiled.requiredSignals;
    formula.requiredParameters = compiled.requiredParameters;
    formula.namedFormulaSlug = (payload.namedFormulaSlug as string) ?? null;
    formula.namedFormulaVersion = (payload.namedFormulaVersion as number) ?? null;
    formula.bindings = (payload.bindings as { role: string; signal: string }[]) ?? [];
    formula.resultKind = (payload.resultKind as FormulaResultKind) ?? compiled.resultKind ?? null;
    formula.displayUnit = (payload.displayUnit as string) ?? compiled.resultUnit ?? null;
    formula.displayFormat = (payload.displayFormat as string) ?? 'number:1';
    formula.targetValue = (payload.targetValue as number) ?? null;
    formula.targetMin = (payload.targetMin as number) ?? null;
    formula.targetMax = (payload.targetMax as number) ?? null;
    formula.targetDirection = (payload.targetDirection as FormulaTargetDirection) ?? 'none';
    formula.comparisonBasis = (payload.comparisonBasis as FormulaComparisonBasis) ?? 'none';
    formula.aggregationWindow = (payload.aggregationWindow as FormulaAggregationWindow) ?? 'shift';
    formula.chartType = (payload.chartType as FormulaChartType) ?? 'none';
    formula.templateVersion = null;
    formula.source = 'generated';
    formula.proposalId = ctx.proposal.id;
    formula.status = 'active';
    formula.updatedBy = ctx.scope.userId;

    const saved = await repo.save(formula);
    return { clientFormulaId: saved.id, formulaKey: saved.formulaKey };
  }
}
