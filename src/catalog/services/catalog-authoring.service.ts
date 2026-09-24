import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { compileFormula, FormulaCompileError } from '../formula/formula-compiler';
import { EquipmentClassFormula } from '../entities/equipment-class-formula.entity';
import { EquipmentClassProfile } from '../entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../entities/scenario-definition.entity';
import { SignalAlias } from '../entities/signal-alias.entity';
import { AlertRuleTemplate } from '../entities/alert-rule-template.entity';
import { validateParams } from '../../alert/services/alert-rules';

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
  ) {}

  async createClass(scope: RequestScope, slug: string, draft: ClassDraft): Promise<EquipmentClassProfile> {
    if (await this.classes.findOne({ where: { slug } })) {
      throw new BadRequestException(`Template "${slug}" already exists. Edit it to create a new version.`);
    }
    this.logger.log(`${scope.userId} created template class "${slug}".`);
    return this.classes.save(this.classes.create({
      slug, version: 1, status: 'draft', publishedAt: null,
      name: draft.name ?? slug,
      description: draft.description ?? null,
      category: draft.category ?? null,
      expectedSignals: draft.expectedSignals ?? [],
      failureModes: draft.failureModes ?? [],
      defaultThresholds: draft.defaultThresholds ?? {},
    }));
  }

  /**
   * Edits the working draft, or forks one from the current published version.
   *
   * A draft is edited in place because nothing has been copied from it. A published
   * version is never touched.
   */
  async editClass(scope: RequestScope, slug: string, draft: ClassDraft): Promise<EquipmentClassProfile> {
    const working = await this.workingClass(slug);
    Object.assign(working, draft);
    this.logger.log(`${scope.userId} edited template class "${slug}" v${working.version}.`);
    return this.classes.save(working);
  }

  /**
   * Publishing is the enforcement point for every formula on the class (task
   * QCE1): draft content may be broken, published content may not. Every formula
   * for this version is compiled here, and a single one that fails to compile
   * blocks the whole publish — the message names every failing formula and why,
   * not just the first, since a person fixing one should not have to republish
   * five times to find the rest.
   */
  async publishClass(scope: RequestScope, slug: string): Promise<EquipmentClassProfile> {
    const draft = await this.classes.findOne({ where: { slug, status: 'draft' }, order: { version: 'DESC' } });
    if (!draft) throw new NotFoundException(`No draft of "${slug}" to publish.`);
    if (!draft.expectedSignals.length) {
      // A class declaring no signals makes every scenario on it permanently blocked,
      // and the blocker names signals the class never promised. Better to refuse.
      throw new BadRequestException(`"${slug}" declares no expected signals; publishing it would help nobody.`);
    }

    const formulas = await this.formulas.find({ where: { classSlug: slug, classVersion: draft.version } });
    const compiled: { formula: EquipmentClassFormula; result: ReturnType<typeof compileFormula> }[] = [];
    const failures: string[] = [];
    for (const formula of formulas) {
      try {
        const result = compileFormula({
          formulaKey: formula.formulaKey,
          expression: formula.expression,
          classSlug: slug,
          expectedSignals: draft.expectedSignals.map((s) => ({ signal: s.signal, unit: s.unit })),
          declaredResultKind: formula.resultKind,
          declaredDisplayUnit: formula.displayUnit,
        });
        compiled.push({ formula, result });
      } catch (err) {
        failures.push(err instanceof FormulaCompileError ? err.message : `formula "${formula.formulaKey}": ${err}`);
      }
    }
    if (failures.length) {
      throw new BadRequestException(
        `Cannot publish "${slug}" v${draft.version}: ${failures.join('; ')}`,
      );
    }

    return this.classes.manager.transaction(async (m) => {
      const now = new Date();
      for (const { formula, result } of compiled) {
        formula.compiledPlan = result.plan as unknown as Record<string, unknown>;
        formula.compiledAt = now;
        formula.compilerVersion = result.compilerVersion;
        formula.resultUnit = result.resultUnit;
        formula.requiredSignals = result.requiredSignals;
        formula.requiredParameters = result.requiredParameters;
      }
      if (compiled.length) await m.getRepository(EquipmentClassFormula).save(compiled.map((c) => c.formula));

      draft.status = 'published';
      draft.publishedAt = now;
      this.logger.log(
        `${scope.userId} published template class "${slug}" v${draft.version}`
          + `${formulas.length ? ` (${formulas.length} formula(s) compiled)` : ''}.`,
      );
      return m.getRepository(EquipmentClassProfile).save(draft);
    });
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
