import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentTemplate } from '../entities/equipment-template.entity';
import { EquipmentTemplateCurvePoint } from '../entities/equipment-template-curve-point.entity';
import { EquipmentTemplateRating } from '../entities/equipment-template-rating.entity';
import { CurveInput, CurveView, toCurveView, validateCurve } from './curves';
import { RatingInput, RatingView, toView, validateRatings } from './ratings';

type TemplateDraft = Partial<Pick<EquipmentTemplate,
  'name' | 'category' | 'manufacturer' | 'engineType' | 'fuelTankCapacityLiters'
  | 'serviceIntervalHours' | 'description' | 'equipmentClassSlug'>>;

/**
 * Flat CRUD, no lifecycle — onboarding convenience, not a versioned product. See the
 * entity's own comment on why this stays separate from `CatalogAuthoringService`.
 */
@Injectable()
export class EquipmentTemplateService {
  constructor(
    @InjectRepository(EquipmentTemplate) private readonly templates: Repository<EquipmentTemplate>,
    private readonly ds: DataSource,
  ) {}

  list(): Promise<EquipmentTemplate[]> {
    return this.templates.find({ order: { name: 'ASC' } });
  }

  create(draft: TemplateDraft): Promise<EquipmentTemplate> {
    if (!draft.name?.trim()) throw new BadRequestException('A template needs a name.');
    return this.templates.save(this.templates.create({
      name: draft.name.trim(),
      category: draft.category ?? null,
      manufacturer: draft.manufacturer ?? null,
      engineType: draft.engineType ?? null,
      fuelTankCapacityLiters: draft.fuelTankCapacityLiters ?? null,
      serviceIntervalHours: draft.serviceIntervalHours ?? null,
      description: draft.description ?? null,
      equipmentClassSlug: draft.equipmentClassSlug?.trim() || null,
    }));
  }

  async update(id: string, draft: TemplateDraft): Promise<EquipmentTemplate> {
    const template = await this.templates.findOne({ where: { id } });
    if (!template) throw new NotFoundException(`No equipment template "${id}".`);
    // `draft` is a class-validator DTO: every optional field TypeScript declares is
    // defined as an own property (value `undefined`) at construction time, even when
    // the request body omitted it — an ordinary Object.assign would copy those
    // `undefined`s onto the entity and null out fields the caller never touched.
    for (const [key, value] of Object.entries(draft)) {
      if (value !== undefined) (template as unknown as Record<string, unknown>)[key] = value;
    }
    return this.templates.save(template);
  }

  async ratings(id: string): Promise<RatingView[]> {
    const template = isUuid(id) ? await this.templates.findOne({ where: { id } }) : null;
    if (!template) throw new NotFoundException(`No equipment template "${id}".`);
    const rows = await this.ds.getRepository(EquipmentTemplateRating)
      .find({ where: { templateId: id }, order: { name: 'ASC' } });
    return rows.map(toView);
  }

  /**
   * Replaces the model's whole set of ratings (D57). Idempotent: the same body twice
   * leaves the same rows. The template row is locked first, so two editors saving at
   * once take turns instead of both deleting and then colliding on insert.
   *
   * An account's copy is not touched (D04, G13): a corrected catalogue figure reaches an
   * account when it copies the model again, not under alerts it already runs.
   */
  async replaceRatings(scope: RequestScope, id: string, input: RatingInput[]): Promise<RatingView[]> {
    const ratings = validateRatings(input);
    if (!isUuid(id)) throw new NotFoundException(`No equipment template "${id}".`);
    return this.ds.transaction(async (m) => {
      const locked = await m.getRepository(EquipmentTemplate).createQueryBuilder('t')
        .where('t.id = :id', { id }).setLock('pessimistic_write').getOne();
      if (!locked) throw new NotFoundException(`No equipment template "${id}".`);
      const repo = m.getRepository(EquipmentTemplateRating);
      await repo.delete({ templateId: id });
      if (ratings.length) {
        await repo.insert(ratings.map((r) => ({
          templateId: id, name: r.name, value: r.value, source: r.source, updatedBy: scope.userId,
        })));
      }
      const rows = await repo.find({ where: { templateId: id }, order: { name: 'ASC' } });
      return rows.map(toView);
    });
  }

  async dutyCurve(id: string): Promise<CurveView> {
    const template = isUuid(id) ? await this.templates.findOne({ where: { id } }) : null;
    if (!template) throw new NotFoundException(`No equipment template "${id}".`);
    return toCurveView(await this.ds.getRepository(EquipmentTemplateCurvePoint).find({ where: { templateId: id, curve: 'duty' } }));
  }

  /**
   * Replaces the model's duty curve (D58). Idempotent, locked on the template row like
   * the ratings. An empty list removes the curve; formulas reading it then answer
   * not_configured on machines of this model, which is the truth.
   */
  async replaceDutyCurve(scope: RequestScope, id: string, input: CurveInput): Promise<CurveView> {
    const curve = input.points?.length ? validateCurve(input) : { source: '', points: [] };
    if (!isUuid(id)) throw new NotFoundException(`No equipment template "${id}".`);
    return this.ds.transaction(async (m) => {
      const locked = await m.getRepository(EquipmentTemplate).createQueryBuilder('t')
        .where('t.id = :id', { id }).setLock('pessimistic_write').getOne();
      if (!locked) throw new NotFoundException(`No equipment template "${id}".`);
      const repo = m.getRepository(EquipmentTemplateCurvePoint);
      await repo.delete({ templateId: id, curve: 'duty' });
      if (curve.points.length) {
        await repo.insert(curve.points.map((p, point) => ({
          templateId: id, curve: 'duty' as const, point, ...p, source: curve.source, updatedBy: scope.userId,
        })));
      }
      return toCurveView(await repo.find({ where: { templateId: id, curve: 'duty' } }));
    });
  }
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
