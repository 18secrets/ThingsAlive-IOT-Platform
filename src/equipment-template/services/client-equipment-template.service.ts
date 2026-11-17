import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantSession } from '../../scope/tenant-session';
import { ClientEquipmentTemplate } from '../entities/client-equipment-template.entity';
import { ClientEquipmentTemplateCurvePoint } from '../entities/client-equipment-template-curve-point.entity';
import { ClientEquipmentTemplateRating } from '../entities/client-equipment-template-rating.entity';
import { EquipmentTemplate } from '../entities/equipment-template.entity';
import { EquipmentTemplateCurvePoint } from '../entities/equipment-template-curve-point.entity';
import { EquipmentTemplateRating } from '../entities/equipment-template-rating.entity';
import { CurveInput, CurveView, toCurveView, validateCurve } from './curves';
import { RatingInput, RatingView, toView, validateRatings } from './ratings';

export type ClientTemplateDraft = Partial<Pick<ClientEquipmentTemplate,
  'name' | 'category' | 'manufacturer' | 'engineType' | 'fuelTankCapacityLiters'
  | 'serviceIntervalHours' | 'description' | 'equipmentClassSlug'>>;

const FIELDS: readonly (keyof ClientTemplateDraft)[] = [
  'name', 'category', 'manufacturer', 'engineType', 'fuelTankCapacityLiters', 'serviceIntervalHours', 'description',
  'equipmentClassSlug',
];

/**
 * A client's own equipment templates (task QCLIENT-TEMPLATE). Every read and write runs
 * in the caller's tenant session, so row-level security answers "whose" before this code
 * does. Another account's template is a 404 — the same answer as one that never existed.
 *
 * Platform roles are refused outright. Master Admin holds both capabilities these routes
 * ask for, and a client's own templates reached from Things Alive belong on the audited
 * cross-tenant path, not on an ordinary route that happens to let them through.
 */
@Injectable()
export class ClientEquipmentTemplateService {
  constructor(private readonly ds: DataSource) {}

  async list(scope: RequestScope): Promise<ClientEquipmentTemplate[]> {
    refusePlatform(scope);
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(ClientEquipmentTemplate).find({ where: { tenantId: scope.tenantId }, order: { name: 'ASC' } }));
  }

  async create(scope: RequestScope, draft: ClientTemplateDraft): Promise<ClientEquipmentTemplate> {
    refusePlatform(scope);
    if (!draft.name?.trim()) throw new BadRequestException('A template needs a name.');
    return withTenantSession(this.ds, scope, (m) => insert(m, scope, { ...pick(draft), name: draft.name!.trim() }, null))
      .catch(mapWriteError);
  }

  /**
   * A copy of one of Master Admin's templates, as the client's own. Provenance only:
   * `copiedFromId` says where it started, and nothing follows it — editing the master
   * afterwards changes no client's copy (G13).
   *
   * Its rated figures come with it, in the same transaction (D57). A model copied
   * without them would leave every motor KPI on a machine naming it not_configured,
   * with nothing on the copy to say why.
   */
  async copyFromMaster(scope: RequestScope, masterId: string, name?: string): Promise<ClientEquipmentTemplate> {
    refusePlatform(scope);
    if (!isUuid(masterId)) throw new NotFoundException(`No equipment template "${masterId}".`);
    return withTenantSession(this.ds, scope, async (m) => {
      const master = await m.getRepository(EquipmentTemplate).findOne({ where: { id: masterId } });
      if (!master) throw new NotFoundException(`No equipment template "${masterId}".`);
      const fields = pick(master);
      const copy = await insert(m, scope, { ...fields, name: name?.trim() || master.name }, master.id);
      const ratings = await m.getRepository(EquipmentTemplateRating).find({ where: { templateId: master.id } });
      if (ratings.length) {
        await m.getRepository(ClientEquipmentTemplateRating).insert(ratings.map((r) => ({
          tenantId: scope.tenantId, templateId: copy.id, name: r.name, value: r.value, source: r.source,
          updatedBy: scope.userId,
        })));
      }
      // The duty curve too (D58), for the same reason as the ratings.
      const points = await m.getRepository(EquipmentTemplateCurvePoint).find({ where: { templateId: master.id } });
      if (points.length) {
        await m.getRepository(ClientEquipmentTemplateCurvePoint).insert(points.map((p) => ({
          tenantId: scope.tenantId, templateId: copy.id, curve: p.curve, point: p.point,
          headM: p.headM, flowLpm: p.flowLpm, inputKw: p.inputKw, source: p.source, updatedBy: scope.userId,
        })));
      }
      return copy;
    }).catch(mapWriteError);
  }

  async dutyCurve(scope: RequestScope, id: string): Promise<CurveView> {
    refusePlatform(scope);
    return withTenantSession(this.ds, scope, async (m) => {
      const template = await this.find(m, scope, id);
      return toCurveView(await m.getRepository(ClientEquipmentTemplateCurvePoint)
        .find({ where: { tenantId: scope.tenantId, templateId: template.id, curve: 'duty' } }));
    });
  }

  /** This account's own duty curve for the model (D58, D04). Idempotent and locked. */
  async replaceDutyCurve(scope: RequestScope, id: string, input: CurveInput): Promise<CurveView> {
    refusePlatform(scope);
    const curve = input.points?.length ? validateCurve(input) : { source: '', points: [] };
    return withTenantSession(this.ds, scope, async (m) => {
      const template = await this.find(m, scope, id);
      await m.getRepository(ClientEquipmentTemplate).createQueryBuilder('t')
        .where('t.id = :id AND t.tenantId = :tenantId', { id: template.id, tenantId: scope.tenantId })
        .setLock('pessimistic_write').getOne();
      const repo = m.getRepository(ClientEquipmentTemplateCurvePoint);
      await repo.delete({ tenantId: scope.tenantId, templateId: template.id, curve: 'duty' });
      if (curve.points.length) {
        await repo.insert(curve.points.map((p, point) => ({
          tenantId: scope.tenantId, templateId: template.id, curve: 'duty' as const, point, ...p,
          source: curve.source, updatedBy: scope.userId,
        })));
      }
      return toCurveView(await repo.find({ where: { tenantId: scope.tenantId, templateId: template.id, curve: 'duty' } }));
    }).catch(mapWriteError);
  }

  async ratings(scope: RequestScope, id: string): Promise<RatingView[]> {
    refusePlatform(scope);
    return withTenantSession(this.ds, scope, async (m) => {
      const template = await this.find(m, scope, id);
      const rows = await m.getRepository(ClientEquipmentTemplateRating)
        .find({ where: { tenantId: scope.tenantId, templateId: template.id }, order: { name: 'ASC' } });
      return rows.map(toView);
    });
  }

  /**
   * Replaces this account's own figures for the model (D57, D04: the copy is theirs).
   * Idempotent, and locked on the template row for the same reason as the library's.
   * Every machine naming this model reads the new figures from its next evaluation.
   */
  async replaceRatings(scope: RequestScope, id: string, input: RatingInput[]): Promise<RatingView[]> {
    refusePlatform(scope);
    const ratings = validateRatings(input);
    return withTenantSession(this.ds, scope, async (m) => {
      const template = await this.find(m, scope, id);
      await m.getRepository(ClientEquipmentTemplate).createQueryBuilder('t')
        .where('t.id = :id AND t.tenantId = :tenantId', { id: template.id, tenantId: scope.tenantId })
        .setLock('pessimistic_write').getOne();
      const repo = m.getRepository(ClientEquipmentTemplateRating);
      await repo.delete({ tenantId: scope.tenantId, templateId: template.id });
      if (ratings.length) {
        await repo.insert(ratings.map((r) => ({
          tenantId: scope.tenantId, templateId: template.id, name: r.name, value: r.value, source: r.source,
          updatedBy: scope.userId,
        })));
      }
      const rows = await repo.find({ where: { tenantId: scope.tenantId, templateId: template.id }, order: { name: 'ASC' } });
      return rows.map(toView);
    }).catch(mapWriteError);
  }

  async update(scope: RequestScope, id: string, draft: ClientTemplateDraft): Promise<ClientEquipmentTemplate> {
    refusePlatform(scope);
    if (draft.name !== undefined && !draft.name?.trim()) throw new BadRequestException('A template needs a name.');
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(ClientEquipmentTemplate);
      const template = await this.find(m, scope, id);
      // A DTO defines every optional field it declares, as `undefined`, even when the
      // body omitted it. Copying those would null out what the caller never touched.
      for (const key of FIELDS) {
        const value = draft[key];
        if (value !== undefined) (template as unknown as Record<string, unknown>)[key] = key === 'name' ? (value as string).trim() : value;
      }
      template.updatedBy = scope.userId;
      return repo.save(template);
    }).catch(mapWriteError);
  }

  /**
   * Deleted, not archived. Equipment that was only pre-filled from it is unaffected; a
   * machine that names it as its model (D57) makes the database refuse, since that
   * machine reads its ratings from here.
   */
  async remove(scope: RequestScope, id: string): Promise<void> {
    refusePlatform(scope);
    await withTenantSession(this.ds, scope, async (m) => {
      const template = await this.find(m, scope, id);
      await m.getRepository(ClientEquipmentTemplate).delete({ tenantId: scope.tenantId, id: template.id });
    }).catch(mapWriteError);
  }

  private async find(m: EntityManager, scope: RequestScope, id: string): Promise<ClientEquipmentTemplate> {
    const notFound = () => new NotFoundException(`No equipment template "${id}" in this account.`);
    if (!isUuid(id)) throw notFound();
    const template = await m.getRepository(ClientEquipmentTemplate).findOne({ where: { tenantId: scope.tenantId, id } });
    if (!template) throw notFound();
    return template;
  }
}

function refusePlatform(scope: RequestScope): void {
  if (scope.isPlatformRole) {
    throw new ForbiddenException('A client\'s own equipment templates have no platform access path.');
  }
}

function pick(source: ClientTemplateDraft): Required<ClientTemplateDraft> {
  return {
    name: source.name ?? '',
    category: source.category ?? null,
    manufacturer: source.manufacturer ?? null,
    engineType: source.engineType ?? null,
    fuelTankCapacityLiters: source.fuelTankCapacityLiters ?? null,
    serviceIntervalHours: source.serviceIntervalHours ?? null,
    description: source.description ?? null,
    equipmentClassSlug: source.equipmentClassSlug ?? null,
  };
}

async function insert(
  m: EntityManager, scope: RequestScope, fields: Required<ClientTemplateDraft>, copiedFromId: string | null,
): Promise<ClientEquipmentTemplate> {
  const repo = m.getRepository(ClientEquipmentTemplate);
  return repo.save(repo.create({
    ...fields, tenantId: scope.tenantId, copiedFromId, createdBy: scope.userId, updatedBy: scope.userId,
  }));
}

function mapWriteError(error: unknown): never {
  if (error instanceof QueryFailedError) {
    const e = error as QueryFailedError & { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'uq_client_equipment_template_name') {
      throw new ConflictException('This account already has a template with that name.');
    }
    if (e.code === '23503' && e.constraint === 'fk_equipment_model_template') {
      throw new ConflictException(
        'Machines name this template as their model and read their rated figures from it. '
          + 'Give them another model, or none, before deleting it.',
      );
    }
    if (e.code === '23514' || e.code === '22P02') throw new BadRequestException(`Refused by the database: ${error.message}`);
  }
  throw error;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
