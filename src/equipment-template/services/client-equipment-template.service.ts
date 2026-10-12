import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantSession } from '../../scope/tenant-session';
import { ClientEquipmentTemplate } from '../entities/client-equipment-template.entity';
import { EquipmentTemplate } from '../entities/equipment-template.entity';

export type ClientTemplateDraft = Partial<Pick<ClientEquipmentTemplate,
  'name' | 'category' | 'manufacturer' | 'engineType' | 'fuelTankCapacityLiters'
  | 'serviceIntervalHours' | 'description'>>;

const FIELDS: readonly (keyof ClientTemplateDraft)[] = [
  'name', 'category', 'manufacturer', 'engineType', 'fuelTankCapacityLiters', 'serviceIntervalHours', 'description',
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
   */
  async copyFromMaster(scope: RequestScope, masterId: string, name?: string): Promise<ClientEquipmentTemplate> {
    refusePlatform(scope);
    if (!isUuid(masterId)) throw new NotFoundException(`No equipment template "${masterId}".`);
    return withTenantSession(this.ds, scope, async (m) => {
      const master = await m.getRepository(EquipmentTemplate).findOne({ where: { id: masterId } });
      if (!master) throw new NotFoundException(`No equipment template "${masterId}".`);
      const fields = pick(master);
      return insert(m, scope, { ...fields, name: name?.trim() || master.name }, master.id);
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

  /** Deleted, not archived: nothing references a template once it is copied into equipment. */
  async remove(scope: RequestScope, id: string): Promise<void> {
    refusePlatform(scope);
    await withTenantSession(this.ds, scope, async (m) => {
      const template = await this.find(m, scope, id);
      await m.getRepository(ClientEquipmentTemplate).delete({ tenantId: scope.tenantId, id: template.id });
    });
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
    if (e.code === '23514' || e.code === '22P02') throw new BadRequestException(`Refused by the database: ${error.message}`);
  }
  throw error;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
