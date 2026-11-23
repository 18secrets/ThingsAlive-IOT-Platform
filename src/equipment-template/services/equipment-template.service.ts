import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { runTenantSpanning, withTenantSession } from '../../scope/tenant-session';
import { EquipmentTemplate } from '../entities/equipment-template.entity';
import { EquipmentTemplateGrant } from '../entities/equipment-template-grant.entity';
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
  private readonly logger = new Logger(EquipmentTemplateService.name);

  constructor(
    @InjectRepository(EquipmentTemplate) private readonly templates: Repository<EquipmentTemplate>,
    private readonly ds: DataSource,
  ) {}

  /**
   * Master Admin: the whole library. An account: the models it was given (TC_234), read
   * in its own session so row security answers whose grants they are.
   */
  async list(scope: RequestScope): Promise<EquipmentTemplate[]> {
    if (scope.isPlatformRole) return this.templates.find({ order: { name: 'ASC' } });
    return withTenantSession(this.ds, scope, (m) => m.getRepository(EquipmentTemplate).createQueryBuilder('t')
      .innerJoin(EquipmentTemplateGrant, 'g', 'g.templateId = t.id AND g.tenantId = :tenantId AND g.revokedAt IS NULL',
        { tenantId: scope.tenantId })
      .orderBy('t.name', 'ASC')
      .getMany());
  }

  /** Every grant, or one account's: Master Admin's view. */
  listGrants(tenantId?: string): Promise<EquipmentTemplateGrant[]> {
    return runTenantSpanning(this.ds, 'model grants: list', (m) =>
      m.getRepository(EquipmentTemplateGrant).find({
        where: tenantId ? { tenantId } : {}, order: { tenantId: 'ASC', grantedAt: 'ASC' },
      }));
  }

  /**
   * Gives an account a library model. Idempotent: granting what the account already has
   * changes nothing and returns the grant it has; granting a revoked model brings that
   * row back. One statement settles a race — two grants fired together leave one row,
   * and the second finds it.
   */
  async grant(scope: RequestScope, tenantId: string, templateId: string, note?: string): Promise<EquipmentTemplateGrant> {
    if (!isUuid(templateId)) throw new NotFoundException(`No equipment template "${templateId}".`);
    return runTenantSpanning(this.ds, `model grant: ${templateId} to ${tenantId}`, async (m) => {
      const [tenant] = await m.query(`SELECT 1 FROM "tenant" WHERE "tenant_id" = $1`, [tenantId]);
      // A grant to an account that does not exist is a typo that would look like a
      // working grant until somebody wondered why nothing showed.
      if (!tenant) throw new BadRequestException(`No account "${tenantId}" to grant to.`);
      if (!(await m.getRepository(EquipmentTemplate).exists({ where: { id: templateId } }))) {
        throw new NotFoundException(`No equipment template "${templateId}".`);
      }
      const [restored] = await m.query(
        `INSERT INTO "equipment_template_grant" ("tenant_id", "template_id", "granted_by", "note")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("tenant_id", "template_id") DO UPDATE
           SET "revoked_at" = NULL, "revoked_by" = NULL, "granted_by" = EXCLUDED."granted_by", "granted_at" = now(),
               "note" = COALESCE(EXCLUDED."note", "equipment_template_grant"."note")
           WHERE "equipment_template_grant"."revoked_at" IS NOT NULL
         RETURNING "id"`,
        [tenantId, templateId, scope.userId, note?.trim() || null],
      );
      if (restored) this.logger.log(`Granted model ${templateId} to ${tenantId} by ${scope.userId}.`);
      // Already granted (and so untouched above), or just written: the row as it stands.
      return m.getRepository(EquipmentTemplateGrant).findOneOrFail({ where: { tenantId, templateId } });
    });
  }

  /**
   * Withdraws a grant. The row stays; revoked is not deleted. The account's copies stay
   * too (D04): the model leaves its list, not its machines.
   */
  async revoke(scope: RequestScope, id: string): Promise<EquipmentTemplateGrant> {
    if (!isUuid(id)) throw new NotFoundException('No active model grant with that id.');
    return runTenantSpanning(this.ds, `model grant: revoke ${id}`, async (m) => {
      const [row] = (await m.query(
        `UPDATE "equipment_template_grant" SET "revoked_at" = now(), "revoked_by" = $2
          WHERE "id" = $1 AND "revoked_at" IS NULL RETURNING "id"`, [id, scope.userId],
      ))[0] ?? [];
      if (!row) throw new NotFoundException('No active model grant with that id.');
      this.logger.warn(`Revoked model grant ${id} by ${scope.userId}.`);
      return m.getRepository(EquipmentTemplateGrant).findOneOrFail({ where: { id } });
    });
  }

  /**
   * An account reading a library model it was not given is told there is no such model,
   * as an ungranted class is: a refusal would say the model exists.
   */
  private async refuseUngranted(scope: RequestScope, id: string): Promise<void> {
    if (scope.isPlatformRole) return;
    const granted = await withTenantSession(this.ds, scope, (m) => isGranted(m, scope.tenantId, id));
    if (!granted) throw new NotFoundException(`No equipment template "${id}".`);
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

  /** The route's read: an account sees the ratings of a model it was given, and only those. */
  async ratingsFor(scope: RequestScope, id: string): Promise<RatingView[]> {
    const rows = await this.ratings(id);
    await this.refuseUngranted(scope, id);
    return rows;
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

  /** The route's read, held to the account's grants like {@link ratingsFor}. */
  async dutyCurveFor(scope: RequestScope, id: string): Promise<CurveView> {
    const curve = await this.dutyCurve(id);
    await this.refuseUngranted(scope, id);
    return curve;
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

/** Whether the account holds an active grant of the model. Run in the account's own session. */
export async function isGranted(m: EntityManager, tenantId: string, templateId: string): Promise<boolean> {
  return m.getRepository(EquipmentTemplateGrant).exists({ where: { tenantId, templateId, revokedAt: IsNull() } });
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
