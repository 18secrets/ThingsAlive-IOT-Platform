import { retiredSignalProblems, rethrowSensorContentError } from '../../device-catalog/services/sensor-retirement';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { compileClassFormulas } from '../formula/formula-compiler';
import {
  checkDimensions, checkSuspiciousBindings, substituteExpression,
} from '../formula/named-formula-binding';
import { EquipmentClassFormula } from '../entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../entities/equipment-class-profile.entity';
import { NamedFormula } from '../entities/named-formula.entity';
import { ScenarioDefinition } from '../entities/scenario-definition.entity';
import { SignalAlias } from '../entities/signal-alias.entity';
import { AlertRuleTemplate } from '../entities/alert-rule-template.entity';
import { SensorRoleCapability } from '../../device-catalog/entities/sensor-role-capability.entity';
import { validateParams } from '../../alert/services/alert-rules';
import { validateScenarioRequiredSignals, validateSignalCountForPublish, validateSignals } from './content-validation';
import {
  ClassContentError, copyClassContent, danglingRecommendations, fromFailureModeJsonb, insertClassContent,
  loadFailureModes, loadRecommendations, replaceDraftFailureModes, undeclaredFailureModeSignals,
} from './class-failure-modes';
import { copyLayout, loadLayout, presentationOf } from './class-layout';
import { copyVisual, visualPublishProblems } from './class-visual.service';
import { layoutProblems } from '../layout/layout-rules';

type ClassDraft = Partial<Pick<EquipmentClassProfile,
  'name' | 'description' | 'category' | 'expectedSignals' | 'failureModes' | 'defaultThresholds'>>;

type ScenarioDraft = Partial<Pick<ScenarioDefinition,
  'name' | 'description' | 'severity' | 'tier' | 'requiredSignals'
  | 'minimumHistoryDays' | 'parameters' | 'equipmentClassSlug'>>;

type AlertTemplateDraft = Partial<Pick<AlertRuleTemplate,
  'name' | 'description' | 'trigger' | 'params' | 'severity' | 'enabledOnCopy'
  | 'equipmentClassSlug'>>;

/**
 * Template authoring, for Things Alive (tasks P1-01, P1-02).
 *
 * This service writes templates and nothing else. It has no method that can reach a
 * client's copy — not a guarded one, not an audited one, none. That is the shape of
 * the model rather than an omission: once a class is granted, the copy belongs to the
 * client, and the way to be sure Things Alive cannot edit it is for the code that
 * edits things to have no route to those tables.
 *
 * Editing a published template forks a new draft version rather than changing it in
 * place. Under the copy model no live alert runs on a template directly, so this is
 * no longer about protecting running alerts — it is about provenance. Every client
 * copy records the template version it came from, and a version edited in place makes
 * that record a lie, which costs exactly when somebody is trying to work out why a
 * customer's scenario behaves differently from the one they think they shipped.
 */
@Injectable()
export class CatalogAuthoringService {
  private readonly logger = new Logger(CatalogAuthoringService.name);

  constructor(
    @InjectRepository(EquipmentClassProfile) private readonly classes: Repository<EquipmentClassProfile>,
    @InjectRepository(EquipmentClassFormula) private readonly formulas: Repository<EquipmentClassFormula>,
    @InjectRepository(ScenarioDefinition) private readonly scenarios: Repository<ScenarioDefinition>,
    @InjectRepository(SignalAlias) private readonly aliases: Repository<SignalAlias>,
    @InjectRepository(AlertRuleTemplate) private readonly alertTemplates: Repository<AlertRuleTemplate>,
    @InjectRepository(NamedFormula) private readonly namedFormulas: Repository<NamedFormula>,
    @InjectRepository(SensorRoleCapability) private readonly capabilities: Repository<SensorRoleCapability>,
  ) {}

  async createClass(scope: RequestScope, slug: string, draft: ClassDraft): Promise<EquipmentClassProfile> {
    if (await this.classes.findOne({ where: { slug } })) {
      throw new BadRequestException(`Template "${slug}" already exists. Edit it to create a new version.`);
    }
    await this.requireSaneSignals(draft.expectedSignals ?? []);
    this.logger.log(`${scope.userId} created template class "${slug}".`);
    // The jsonb is still written (deprecated, task QREC0a); the rows are what is read.
    // Through `this.classes.manager` rather than an injected repository, so every
    // existing caller that constructs this service keeps working unchanged.
    return this.classes.manager.transaction(async (m) => {
      const saved = await m.getRepository(EquipmentClassProfile).save(this.classes.create({
        slug, version: 1, status: 'draft', publishedAt: null,
        name: draft.name ?? slug,
        description: draft.description ?? null,
        category: draft.category ?? null,
        expectedSignals: draft.expectedSignals ?? [],
        failureModes: draft.failureModes ?? [],
        defaultThresholds: draft.defaultThresholds ?? {},
      }));
      await insertClassContent(
        m, slug, 1, fromFailureModeJsonb(draft.failureModes ?? []), [], { source: 'manual', importBatchId: null },
      );
      return saved;
    }).catch(rethrowSensorContentError);
  }

  /**
   * Edits the working draft, or forks one from the current published version.
   *
   * A draft is edited in place because nothing has been copied from it. A published
   * version is never touched.
   */
  async editClass(scope: RequestScope, slug: string, draft: ClassDraft): Promise<EquipmentClassProfile> {
    const working = await this.workingClass(slug);
    const previous = working.id ? working.expectedSignals : [];
    const forked = !working.id;
    Object.assign(working, draft);
    await this.requireSaneSignals(working.expectedSignals, previous);
    this.logger.log(`${scope.userId} edited template class "${slug}" v${working.version}.`);
    return this.classes.manager.transaction(async (m) => {
      const saved = await m.getRepository(EquipmentClassProfile).save(working);
      // A fork starts as a copy of the version it came from (task QREC0a) — the
      // jsonb did this by riding on the profile row; rows only do it if asked.
      if (forked) {
        await copyClassContent(m, slug, working.version - 1, working.version);
        await copyLayout(m, slug, working.version - 1, working.version);
        await copyVisual(m, slug, working.version - 1, working.version);
      }
      if (draft.failureModes) {
        try {
          await replaceDraftFailureModes(
            m, slug, working.version, draft.failureModes, { source: 'manual', importBatchId: null },
          );
        } catch (err) {
          if (err instanceof ClassContentError) throw new BadRequestException(err.message);
          throw err;
        }
      }
      return saved;
    }).catch(rethrowSensorContentError);
  }

  /**
   * Publishing is the enforcement point for every formula on the class (task
   * QCE1). Every formula for this version is compiled together (task QCE1.1),
   * so `#other_formula_key` resolves within the class+version — a single formula
   * that fails to compile blocks the whole publish, and so does any formula that
   * depends on it, named individually and by reason, not just the first failure.
   *
   * `required_formulas` is computed by the compiler but not persisted: there is
   * no column for it, and this task's own instructions say not to add one
   * without saying why first (see the final report — folding it into
   * compiled_plan would silently change that column's shape).
   */
  /**
   * `acknowledgeWarnings` (task QCE3, same audited-override shape QIMP4 established
   * for `acknowledgeWarnings` on apply) covers exactly one thing: `suspicious_binding`
   * — a bound signal whose catalogued capability disagrees with what the role expects
   * to measure. A dimension mismatch is never covered by it; that is a plain input
   * error, not a risk somebody can knowingly accept.
   */
  async publishClass(
    scope: RequestScope, slug: string, acknowledgeWarnings = false,
  ): Promise<EquipmentClassProfile> {
    const draft = await this.classes.findOne({ where: { slug, status: 'draft' }, order: { version: 'DESC' } });
    if (!draft) throw new NotFoundException(`No draft of "${slug}" to publish.`);
    const signalProblem = validateSignalCountForPublish(draft.expectedSignals);
    if (signalProblem) {
      throw new BadRequestException(`"${slug}" ${signalProblem}`);
    }

    await this.requireSaneSignals(draft.expectedSignals);

    // Content that references something absent is a defect, not a draft (task
    // QREC0a). The recommendation check cannot fire through any path that writes
    // rows today — the foreign key refuses a dangling one at insert — and is kept as
    // the net for one that someday might, saying both names rather than a constraint's.
    const [failureModes, recommendations] = await Promise.all([
      loadFailureModes(this.classes.manager, slug, draft.version),
      loadRecommendations(this.classes.manager, slug, draft.version),
    ]);
    const contentProblems = [
      ...undeclaredFailureModeSignals(failureModes, draft.expectedSignals.map((s) => s.signal)),
      ...danglingRecommendations(recommendations, failureModes),
      // The visual (task QREC0c): an anchor on an undeclared signal, or an upload never
      // confirmed. No visual at all publishes normally.
      ...await visualPublishProblems(this.classes.manager, slug, draft.version, draft.expectedSignals.map((s) => s.signal)),
    ];
    if (contentProblems.length) {
      throw new BadRequestException(`Cannot publish "${slug}" v${draft.version}: ${contentProblems.join(' ')}`);
    }

    const formulas = await this.formulas.find({ where: { classSlug: slug, classVersion: draft.version } });
    const signalUnits = new Map(draft.expectedSignals.map((s) => [s.signal, s.unit]));

    // Bound formulas (task QCE3) are resolved before compiling: the named formula's
    // role-named expression becomes the bound signal's own text, so downstream —
    // the compiler, the stored `compiled_plan`, everything — treats it exactly like
    // one an author typed by hand. Resolved here, not at apply, for the same reason
    // an expression-mode formula is not compiled at apply either: a draft can sit
    // unpublished indefinitely, and nothing about it should go stale while it does.
    const dimensionProblems: string[] = [];
    const suspiciousProblems: string[] = [];
    for (const formula of formulas) {
      if (!formula.namedFormulaSlug) continue;
      const named = await this.namedFormulas.findOne({
        where: {
          slug: formula.namedFormulaSlug,
          ...(formula.namedFormulaVersion != null ? { version: formula.namedFormulaVersion } : {}),
          status: 'published',
        },
        order: { version: 'DESC' },
      });
      if (!named) {
        // Already caught by the import validator for an Excel-sourced row; this is
        // the safety net for any other path that could write a bind-mode row.
        dimensionProblems.push(
          `"${formula.formulaKey}": named formula "${formula.namedFormulaSlug}" is not published, or does not exist.`,
        );
        continue;
      }

      const mismatches = checkDimensions(named.inputs, formula.bindings, signalUnits);
      for (const m of mismatches) {
        dimensionProblems.push(
          `"${formula.formulaKey}": role "${m.role}" expects "${m.expectedDimension}" but is bound to `
            + `"${m.signal}" ("${m.actualUnit}").`,
        );
      }

      const boundSignals = [...new Set(formula.bindings.map((b) => b.signal))];
      const capabilityRows = boundSignals.length
        ? await this.capabilities.find({ where: { measurementRole: In(boundSignals) } })
        : [];
      const parameterKeysBySignal = new Map<string, string[]>();
      for (const row of capabilityRows) {
        if (!row.parameterKey) continue;
        const list = parameterKeysBySignal.get(row.measurementRole) ?? [];
        list.push(row.parameterKey);
        parameterKeysBySignal.set(row.measurementRole, list);
      }
      for (const s of checkSuspiciousBindings(named.inputs, formula.bindings, parameterKeysBySignal)) {
        suspiciousProblems.push(
          `"${formula.formulaKey}": role "${s.role}" expects one of [${s.expectedParameters.join(', ')}] but `
            + `"${s.signal}" measures [${s.boundParameterKeys.join(', ')}] (suspicious_binding).`,
        );
      }

      // Substituted now so the compile step below sees the same text the formula
      // will actually run — a bound formula and the hand-written equivalent must
      // produce an identical compiled_plan, which only holds if both are compiled
      // from identical expression text.
      formula.expression = substituteExpression(named.expression, formula.bindings);
    }

    if (dimensionProblems.length) {
      throw new BadRequestException(`Cannot publish "${slug}" v${draft.version}: ${dimensionProblems.join(' ')}`);
    }
    if (suspiciousProblems.length && !acknowledgeWarnings) {
      throw new BadRequestException(
        `Refused: ${suspiciousProblems.join(' ')} Pass acknowledgeWarnings: true to publish anyway.`,
      );
    }

    const results = compileClassFormulas({
      classSlug: slug,
      expectedSignals: draft.expectedSignals.map((s) => ({ signal: s.signal, unit: s.unit })),
      formulas: formulas.map((formula) => ({
        formulaKey: formula.formulaKey,
        expression: formula.expression,
        declaredResultKind: formula.resultKind ?? undefined,
        declaredDisplayUnit: formula.displayUnit,
        declaredChartType: formula.chartType,
      })),
    });

    const failures: string[] = [];
    for (const formula of formulas) {
      const result = results.get(formula.formulaKey)!;
      if (result.status === 'error') failures.push(result.error.message);
    }
    if (failures.length) {
      throw new BadRequestException(
        `Cannot publish "${slug}" v${draft.version}: ${failures.join('; ')}`,
      );
    }

    // The page layout (task QREC0b), checked against what the formulas just compiled
    // to — a widget has to agree with its formula's presentation, and the compiled
    // result_kind is only known from here on. No layout rows is valid: the page
    // falls back to a computed one, and publishing is never gated on authoring it.
    const layout = await loadLayout(this.classes.manager, slug, draft.version);
    if (layout.length) {
      const presentations = formulas.map((formula) => {
        const result = results.get(formula.formulaKey)!;
        const resultKind = formula.resultKind
          ?? (result.status === 'ok' ? result.compiled.resultKind : null);
        return presentationOf({ ...formula, resultKind });
      });
      const layoutIssues = layoutProblems(layout, {
        scope: 'equipment', formulas: presentations, signals: draft.expectedSignals.map((s) => s.signal),
      });
      if (layoutIssues.length) {
        throw new BadRequestException(`Cannot publish "${slug}" v${draft.version}: ${layoutIssues.join(' ')}`);
      }
    }

    return this.classes.manager.transaction(async (m) => {
      const now = new Date();
      for (const formula of formulas) {
        const result = results.get(formula.formulaKey)!;
        if (result.status !== 'ok') continue;
        // required_formulas (task QCE1.1) is not persisted here — see the note on
        // publishClass and the final report: it has no column of its own, and
        // folding it into compiled_plan would change that column's shape out from
        // under `equipment_class_formula`'s already-committed migration and its
        // existing tests.
        formula.compiledPlan = result.compiled.plan as unknown as Record<string, unknown>;
        formula.compiledAt = now;
        formula.compilerVersion = result.compiled.compilerVersion;
        formula.resultUnit = result.compiled.resultUnit;
        formula.requiredSignals = result.compiled.requiredSignals;
        formula.requiredParameters = result.compiled.requiredParameters;
        // Nobody declared one — the compiler's own inference is the only kind
        // this formula has ever had, so that is what gets persisted.
        if (formula.resultKind === null) formula.resultKind = result.compiled.resultKind;
      }
      if (formulas.length) await m.getRepository(EquipmentClassFormula).save(formulas);

      draft.status = 'published';
      draft.publishedAt = now;
      this.logger.log(
        `${scope.userId} published template class "${slug}" v${draft.version}`
          + `${formulas.length ? ` (${formulas.length} formula(s) compiled)` : ''}.`,
      );
      return m.getRepository(EquipmentClassProfile).save(draft);
    }).catch(rethrowSensorContentError);
  }

  /**
   * Retires a template. Existing client copies are untouched and keep working —
   * retiring means "stop offering this", not "take it away from people who have it".
   */
  async retireClass(scope: RequestScope, slug: string): Promise<EquipmentClassProfile[]> {
    const published = await this.classes.find({ where: { slug, status: 'published' } });
    if (!published.length) throw new NotFoundException(`No published "${slug}" to retire.`);
    for (const row of published) row.status = 'retired';
    this.logger.warn(`${scope.userId} retired template class "${slug}". Existing copies keep running.`);
    return this.classes.save(published);
  }

  async createScenario(scope: RequestScope, slug: string, draft: ScenarioDraft): Promise<ScenarioDefinition> {
    if (await this.scenarios.findOne({ where: { slug } })) {
      throw new BadRequestException(`Template scenario "${slug}" already exists. Edit it to create a new version.`);
    }
    if (!draft.equipmentClassSlug) {
      throw new BadRequestException('A scenario must name the equipment class it belongs to.');
    }
    await this.requireDeclaredSignals(draft.equipmentClassSlug, draft.requiredSignals ?? []);
    this.logger.log(`${scope.userId} created template scenario "${slug}".`);
    return this.scenarios.save(this.scenarios.create({
      slug, version: 1, status: 'draft', publishedAt: null,
      equipmentClassSlug: draft.equipmentClassSlug,
      name: draft.name ?? slug,
      description: draft.description ?? null,
      severity: draft.severity,
      tier: draft.tier ?? 1,
      requiredSignals: draft.requiredSignals ?? [],
      minimumHistoryDays: draft.minimumHistoryDays ?? 0,
      parameters: draft.parameters ?? [],
    }));
  }

  async editScenario(scope: RequestScope, slug: string, draft: ScenarioDraft): Promise<ScenarioDefinition> {
    const working = await this.workingScenario(slug);
    const classSlug = draft.equipmentClassSlug ?? working.equipmentClassSlug;
    if (draft.requiredSignals) await this.requireDeclaredSignals(classSlug, draft.requiredSignals);
    Object.assign(working, draft);
    this.logger.log(`${scope.userId} edited template scenario "${slug}" v${working.version}.`);
    return this.scenarios.save(working);
  }

  async publishScenario(scope: RequestScope, slug: string): Promise<ScenarioDefinition> {
    const draft = await this.scenarios.findOne({ where: { slug, status: 'draft' }, order: { version: 'DESC' } });
    if (!draft) throw new NotFoundException(`No draft of "${slug}" to publish.`);
    await this.requireDeclaredSignals(draft.equipmentClassSlug, draft.requiredSignals);
    const requiredProblem = validateScenarioRequiredSignals(draft.requiredSignals);
    if (requiredProblem) throw new BadRequestException(`"${slug}": ${requiredProblem}`);
    draft.status = 'published';
    draft.publishedAt = new Date();
    this.logger.log(`${scope.userId} published template scenario "${slug}" v${draft.version}.`);
    return this.scenarios.save(draft);
  }

  async upsertAlias(
    scope: RequestScope, sourceSystem: string, alias: string, canonical: string,
    unit: string | null, note: string | null,
  ): Promise<SignalAlias> {
    const key = alias.trim().toLowerCase();
    const existing = await this.aliases.findOne({ where: { sourceSystem, alias: key } });
    this.logger.log(`${scope.userId} mapped "${key}" (${sourceSystem}) to "${canonical}".`);
    return this.aliases.save(this.aliases.create({
      ...(existing ?? {}), sourceSystem, alias: key, canonical, unit, note,
    }));
  }

  async deleteAlias(scope: RequestScope, sourceSystem: string, alias: string): Promise<void> {
    const key = alias.trim().toLowerCase();
    const row = await this.aliases.findOne({ where: { sourceSystem, alias: key } });
    if (!row) throw new NotFoundException(`No alias "${key}" for "${sourceSystem}".`);
    await this.aliases.remove(row);
    this.logger.warn(`${scope.userId} removed alias "${key}" (${sourceSystem}).`);
  }

  // ---- What the authoring console reads (task P1-133) ---------------------------
  //
  // Every version and every status, because the authoring screen is where a draft is
  // supposed to be visible. These are separate from the reads in CatalogService, which
  // narrow by entitlement and return published rows only — and must keep doing so.

  allClasses(): Promise<EquipmentClassProfile[]> {
    return this.classes.find({ order: { slug: 'ASC', version: 'DESC' } });
  }

  allScenarios(equipmentClassSlug?: string): Promise<ScenarioDefinition[]> {
    return this.scenarios.find({
      where: equipmentClassSlug ? { equipmentClassSlug } : {},
      order: { slug: 'ASC', version: 'DESC' },
    });
  }

  allAlertTemplates(equipmentClassSlug?: string): Promise<AlertRuleTemplate[]> {
    return this.alertTemplates.find({
      where: equipmentClassSlug ? { equipmentClassSlug } : {},
      order: { slug: 'ASC', version: 'DESC' },
    });
  }

  allAliases(): Promise<SignalAlias[]> {
    return this.aliases.find({ order: { sourceSystem: 'ASC', alias: 'ASC' } });
  }

  // ---- Alert rule templates (task P1-128) --------------------------------------
  //
  // The fourth kind of catalog content, and it works exactly like the other three on
  // purpose. A customer should not have to learn that scenarios version one way and
  // alert rules another, and a second copy mechanism is a second thing to get wrong.

  async createAlertTemplate(
    scope: RequestScope, slug: string, draft: AlertTemplateDraft,
  ): Promise<AlertRuleTemplate> {
    if (await this.alertTemplates.findOne({ where: { slug } })) {
      throw new BadRequestException(`Alert template "${slug}" already exists. Edit it to create a new version.`);
    }
    if (!draft.equipmentClassSlug) {
      throw new BadRequestException('An alert template must name the equipment class it belongs to.');
    }
    if (!draft.trigger) throw new BadRequestException('An alert template needs a trigger.');

    await this.requireAlertTemplateSane(draft.equipmentClassSlug, draft);
    this.logger.log(`${scope.userId} created alert template "${slug}".`);
    return this.alertTemplates.save(this.alertTemplates.create({
      slug, version: 1, status: 'draft', publishedAt: null,
      equipmentClassSlug: draft.equipmentClassSlug,
      name: draft.name ?? slug,
      description: draft.description ?? null,
      trigger: draft.trigger,
      params: draft.params ?? ({} as any),
      severity: draft.severity ?? ('high' as any),
      enabledOnCopy: draft.enabledOnCopy ?? true,
      createdBy: scope.userId,
    }));
  }

  async editAlertTemplate(
    scope: RequestScope, slug: string, draft: AlertTemplateDraft,
  ): Promise<AlertRuleTemplate> {
    const working = await this.workingAlertTemplate(slug);
    Object.assign(working, draft);
    await this.requireAlertTemplateSane(working.equipmentClassSlug, working);
    this.logger.log(`${scope.userId} edited alert template "${slug}" v${working.version}.`);
    return this.alertTemplates.save(working);
  }

  async publishAlertTemplate(scope: RequestScope, slug: string): Promise<AlertRuleTemplate> {
    const draft = await this.alertTemplates.findOne({
      where: { slug, status: 'draft' }, order: { version: 'DESC' },
    });
    if (!draft) throw new NotFoundException(`No draft of alert template "${slug}" to publish.`);
    await this.requireAlertTemplateSane(draft.equipmentClassSlug, draft);
    draft.status = 'published';
    draft.publishedAt = new Date();
    this.logger.log(`${scope.userId} published alert template "${slug}" v${draft.version}.`);
    return this.alertTemplates.save(draft);
  }

  /**
   * Stops offering it. Copies already in client accounts keep running, and keep being
   * the client's — retiring a template has never meant reaching into an account.
   */
  async retireAlertTemplate(scope: RequestScope, slug: string): Promise<AlertRuleTemplate[]> {
    const published = await this.alertTemplates.find({ where: { slug, status: 'published' } });
    if (!published.length) throw new NotFoundException(`No published alert template "${slug}" to retire.`);
    for (const row of published) row.status = 'retired';
    this.logger.warn(`${scope.userId} retired alert template "${slug}". Existing copies keep running.`);
    return this.alertTemplates.save(published);
  }

  /** The draft in progress, or a fresh fork of the current published version. */
  private async workingClass(slug: string): Promise<EquipmentClassProfile> {
    const draft = await this.classes.findOne({ where: { slug, status: 'draft' }, order: { version: 'DESC' } });
    if (draft) return draft;

    const published = await this.classes.findOne({ where: { slug }, order: { version: 'DESC' } });
    if (!published) throw new NotFoundException(`No template class "${slug}".`);

    return this.classes.create({
      ...published, id: undefined as any,
      version: published.version + 1, status: 'draft', publishedAt: null,
    });
  }

  private async workingScenario(slug: string): Promise<ScenarioDefinition> {
    const draft = await this.scenarios.findOne({ where: { slug, status: 'draft' }, order: { version: 'DESC' } });
    if (draft) return draft;

    const published = await this.scenarios.findOne({ where: { slug }, order: { version: 'DESC' } });
    if (!published) throw new NotFoundException(`No template scenario "${slug}".`);

    return this.scenarios.create({
      ...published, id: undefined as any,
      version: published.version + 1, status: 'draft', publishedAt: null,
    });
  }

  private async workingAlertTemplate(slug: string): Promise<AlertRuleTemplate> {
    const draft = await this.alertTemplates.findOne({
      where: { slug, status: 'draft' }, order: { version: 'DESC' },
    });
    if (draft) return draft;

    const published = await this.alertTemplates.findOne({ where: { slug }, order: { version: 'DESC' } });
    if (!published) throw new NotFoundException(`No alert template "${slug}".`);

    return this.alertTemplates.create({
      ...published, id: undefined as any,
      version: published.version + 1, status: 'draft', publishedAt: null,
    });
  }

  /**
   * The template is checked by the same function that checks a client's own rule.
   *
   * A template that passes here and fails on copy would be a rule Things Alive shipped
   * that no account can hold — discovered at grant time, in front of a customer, for a
   * mistake made weeks earlier by somebody else.
   *
   * The signal check is the scenario rule again: a threshold on a signal the class does
   * not declare copies into every account and never fires, and the reason is invisible
   * from inside the account, because the class is ours.
   */
  private async requireAlertTemplateSane(
    classSlug: string, draft: AlertTemplateDraft,
  ): Promise<void> {
    if (!draft.trigger) throw new BadRequestException('An alert template needs a trigger.');
    const problem = validateParams(draft.trigger, draft.params ?? ({} as any));
    if (problem) throw new BadRequestException(problem);

    const watched = (draft.params as { signal?: string } | undefined)?.signal;
    if (draft.trigger === 'signal-threshold' && watched) {
      await this.requireDeclaredSignals(classSlug, [watched]);
    }
  }

  /** Existing draft roles remain editable; a new version or publish rechecks all
   * roles. Uncatalogued legacy roles remain supported on both authoring paths. */
  private async requireSaneSignals(
    signals: ClassDraft['expectedSignals'], previous: NonNullable<ClassDraft['expectedSignals']> = [],
  ): Promise<void> {
    const added = (signals ?? []).filter((s) => !previous.some((p) => p.signal === s.signal && p.unit === s.unit));
    const problems = [...validateSignals(signals ?? []), ...await retiredSignalProblems(this.classes.manager, added)];
    if (problems.length) throw new BadRequestException(problems.join(' '));
  }

  /**
   * The same rule the seeder enforces. A scenario requiring a signal its class does
   * not declare is permanently blocked, and the blocker tells the customer to fit a
   * sensor that may already be fitted — the engine cannot tell a typo from an absence.
   */
  private async requireDeclaredSignals(classSlug: string, signals: string[]): Promise<void> {
    if (!signals.length) return;
    const owner = await this.classes.findOne({ where: { slug: classSlug }, order: { version: 'DESC' } });
    if (!owner) throw new BadRequestException(`No template class "${classSlug}".`);
    const declared = new Set(owner.expectedSignals.map((s) => s.signal));
    const unknown = signals.filter((s) => !declared.has(s));
    if (unknown.length) {
      throw new BadRequestException(
        `"${classSlug}" does not declare: ${unknown.join(', ')}. Add the signal to the class first.`,
      );
    }
  }
}
