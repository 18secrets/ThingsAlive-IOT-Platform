import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { compileFormula, FormulaCompileError } from '../formula/formula-compiler';
import { RoleInput } from '../formula/named-formula-binding';
import { NamedFormula, NamedFormulaResultKind } from '../entities/named-formula.entity';

export type NamedFormulaDraft = Partial<Pick<NamedFormula,
  'name' | 'description' | 'category' | 'expression' | 'inputs' | 'resultDimension' | 'resultKind'>>;

/**
 * The named formula catalogue: physics authored once, published, immutable (task
 * QCE3, D33). Same validator whichever door it arrives through (QIMP4's rule) —
 * publish here is the only place `inputs`/`expression` are ever compiled, and a
 * class binding to a named formula never re-derives that check; it trusts a row
 * this service already refused to publish if it could not compile.
 */
@Injectable()
export class NamedFormulaService {
  private readonly logger = new Logger(NamedFormulaService.name);

  constructor(
    @InjectRepository(NamedFormula) private readonly formulas: Repository<NamedFormula>,
  ) {}

  list(status?: string, category?: string): Promise<NamedFormula[]> {
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (category) where.category = category;
    return this.formulas.find({ where, order: { slug: 'ASC', version: 'DESC' } });
  }

  allVersions(slug: string): Promise<NamedFormula[]> {
    return this.formulas.find({ where: { slug }, order: { version: 'DESC' } });
  }

  /**
   * A fresh slug gets version 1. An existing slug whose latest version is already
   * published forks the next version as a new draft — the same "fork from
   * published" shape `CatalogAuthoringService.workingClass` uses, exposed through
   * POST because this catalogue has no separate PATCH-creates-a-version route.
   * An existing slug that already has a draft in progress is refused: edit that
   * one via PATCH rather than silently starting a second.
   */
  async create(scope: RequestScope, slug: string, draft: NamedFormulaDraft): Promise<NamedFormula> {
    this.requireComplete(draft);
    const existingDraft = await this.formulas.findOne({ where: { slug, status: 'draft' } });
    if (existingDraft) {
      throw new BadRequestException(
        `"${slug}" already has a draft (v${existingDraft.version}) in progress. Edit it instead.`,
      );
    }
    const latest = await this.formulas.findOne({ where: { slug }, order: { version: 'DESC' } });
    const version = latest ? latest.version + 1 : 1;
    this.logger.log(`${scope.userId} created named formula "${slug}" v${version}.`);
    return this.formulas.save(this.formulas.create({
      slug, version, status: 'draft', publishedAt: null, createdBy: scope.userId,
      name: draft.name!, description: draft.description ?? null, category: draft.category ?? null,
      expression: draft.expression!, inputs: draft.inputs!,
      resultDimension: draft.resultDimension ?? null, resultKind: draft.resultKind ?? null,
    }));
  }

  /** Draft only — a published row has no edit route at all, which is what makes
   * "published named formulas are immutable" a property of the wiring rather than
   * a check someone could forget to add to a new caller. */
  async edit(scope: RequestScope, slug: string, version: number, draft: NamedFormulaDraft): Promise<NamedFormula> {
    const row = await this.formulas.findOne({ where: { slug, version } });
    if (!row) throw new NotFoundException(`No named formula "${slug}" v${version}.`);
    if (row.status !== 'draft') {
      throw new BadRequestException(`"${slug}" v${version} is published and cannot be edited.`);
    }
    Object.assign(row, draft);
    this.logger.log(`${scope.userId} edited named formula "${slug}" v${version}.`);
    return this.formulas.save(row);
  }

  /**
   * Compiles `expression` against a synthetic signal list built from `inputs` —
   * each role treated as a signal of its declared dimension, exactly as a bound
   * class formula will be once a real signal stands in for the role (§2). A
   * formula that cannot compile cannot be published; `result_dimension` and
   * `result_kind`, if declared, are checked against the inference and must agree.
   * Neither is required — undeclared means infer-and-persist, D32's pattern,
   * applied here the same way `equipment_class_formula.result_kind` already uses
   * it.
   */
  async publish(scope: RequestScope, slug: string, version: number): Promise<NamedFormula> {
    const row = await this.formulas.findOne({ where: { slug, version } });
    if (!row) throw new NotFoundException(`No named formula "${slug}" v${version}.`);
    if (row.status === 'published') {
      throw new BadRequestException(`"${slug}" v${version} is already published.`);
    }

    const expectedSignals = row.inputs.map((i) => ({ signal: i.role, unit: i.dimension }));
    let compiled: ReturnType<typeof compileFormula>;
    try {
      compiled = compileFormula({
        formulaKey: slug, expression: row.expression, classSlug: `named-formula:${slug}`, expectedSignals,
        declaredResultKind: row.resultKind ?? undefined,
        declaredDisplayUnit: row.resultDimension ?? undefined,
      });
    } catch (err) {
      if (err instanceof FormulaCompileError) {
        // "display_unit" is the compiler's own vocabulary for a generic declared
        // unit; named formulas call the same field result_dimension, so the
        // refusal is rewritten to the name the author actually set.
        throw new BadRequestException(
          `Cannot publish "${slug}" v${version}: ${err.message.replace('display_unit', 'result_dimension')}`,
        );
      }
      throw err;
    }

    row.compiledPlan = compiled.plan as unknown as Record<string, unknown>;
    row.compiledAt = new Date();
    row.compilerVersion = compiled.compilerVersion;
    row.resultUnit = compiled.resultUnit;
    if (row.resultKind === null) row.resultKind = compiled.resultKind as NamedFormulaResultKind;
    if (row.resultDimension === null) row.resultDimension = compiled.resultUnit;
    row.status = 'published';
    row.publishedAt = new Date();
    this.logger.log(`${scope.userId} published named formula "${slug}" v${version}.`);
    return this.formulas.save(row);
  }

  private requireComplete(draft: NamedFormulaDraft): void {
    if (!draft.name?.trim()) throw new BadRequestException('A named formula needs a name.');
    if (!draft.expression?.trim()) throw new BadRequestException('A named formula needs an expression.');
    if (!draft.inputs?.length) throw new BadRequestException('A named formula needs at least one input role.');
    const roles = new Set<string>();
    for (const input of draft.inputs as RoleInput[]) {
      if (!input.role?.trim()) throw new BadRequestException('Every input needs a role name.');
      if (!input.dimension?.trim()) throw new BadRequestException(`Role "${input.role}" needs a dimension.`);
      if (roles.has(input.role)) throw new BadRequestException(`Role "${input.role}" is declared more than once.`);
      roles.add(input.role);
    }
  }
}
