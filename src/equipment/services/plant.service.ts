import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, Not } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantSession } from '../../scope/tenant-session';
import { EquipmentProfile } from '../equipment-profile.entity';
import { Plant, PlantStatus } from '../entities/plant.entity';

export interface PlantInput {
  code: string;
  name: string;
  address?: string | null;
  siteArea?: string | null;
  capacity?: string | null;
  projectType?: string | null;
  operationalStatus?: string | null;
  description?: string | null;
  sourceSystem?: string | null;
  externalId?: string | null;
}

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/**
 * The client's sites (task P1-85).
 *
 * Owned by their CEO or manager, as agreed. Every method runs inside the caller's
 * tenant session, so a site belonging to another account is not refused — it is not
 * there.
 */
@Injectable()
export class PlantService {
  constructor(private readonly ds: DataSource) {}

  async list(scope: RequestScope, includeRetired = false): Promise<Plant[]> {
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(Plant).find({
        where: includeRetired
          ? { tenantId: scope.tenantId }
          : { tenantId: scope.tenantId, status: 'active' },
        order: { name: 'ASC' },
      }));
  }

  async create(scope: RequestScope, input: PlantInput): Promise<Plant> {
    this.assertCode(input.code);
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(Plant);
      if (await repo.findOne({ where: { tenantId: scope.tenantId, code: input.code } })) {
        throw new ConflictException(`A site with the code "${input.code}" already exists.`);
      }
      return repo.save(repo.create({
        tenantId: scope.tenantId,
        code: input.code,
        name: input.name.trim(),
        address: input.address ?? null,
        siteArea: input.siteArea ?? null,
        capacity: input.capacity ?? null,
        projectType: input.projectType ?? null,
        operationalStatus: input.operationalStatus ?? null,
        description: input.description ?? null,
        status: 'active',
        sourceSystem: input.sourceSystem ?? null,
        externalId: input.externalId ?? null,
        createdBy: scope.userId,
        updatedBy: scope.userId,
      }));
    });
  }

  /**
   * Edit a site. The code can change and the id cannot.
   *
   * Renaming a site is ordinary — a customer reorganises, a plant is sold, a name was
   * wrong. Everything points at the id, so a rename costs nothing; if the code were
   * the key, it would silently re-point every machine.
   */
  async update(scope: RequestScope, id: string, input: Partial<PlantInput>): Promise<Plant> {
    if (input.code !== undefined) this.assertCode(input.code);
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(Plant);
      const plant = await repo.findOne({ where: { tenantId: scope.tenantId, id } });
      if (!plant) throw new NotFoundException('No such site in this account.');

      if (input.code !== undefined && input.code !== plant.code) {
        const clash = await repo.findOne({
          where: { tenantId: scope.tenantId, code: input.code, id: Not(id) },
        });
        if (clash) throw new ConflictException(`A site with the code "${input.code}" already exists.`);
        plant.code = input.code;
      }
      for (const key of ['name', 'address', 'siteArea', 'capacity', 'projectType',
        'operationalStatus', 'description'] as const) {
        if (input[key] !== undefined) (plant as any)[key] = input[key] ?? null;
      }
      plant.updatedBy = scope.userId;
      return repo.save(plant);
    });
  }

  /**
   * Close a site, once nothing is standing on it.
   *
   * Refused while equipment is still placed there, and the count is in the message.
   * Retiring a site with machines on it would leave them placed somewhere that no
   * longer appears in a list — visible to nobody whose scope is derived from sites,
   * which is every site manager.
   */
  async retire(scope: RequestScope, id: string): Promise<Plant> {
    return this.setStatus(scope, id, 'retired');
  }

  async reopen(scope: RequestScope, id: string): Promise<Plant> {
    return this.setStatus(scope, id, 'active');
  }

  private async setStatus(scope: RequestScope, id: string, status: PlantStatus): Promise<Plant> {
    return withTenantSession(this.ds, scope, async (m) => {
      const repo = m.getRepository(Plant);
      const plant = await repo.findOne({ where: { tenantId: scope.tenantId, id } });
      if (!plant) throw new NotFoundException('No such site in this account.');

      if (status === 'retired') {
        const standing = await m.getRepository(EquipmentProfile).count({
          where: { tenantId: scope.tenantId, plantId: id, status: 'active' },
        });
        if (standing > 0) {
          throw new ConflictException(
            `${standing} ${standing === 1 ? 'machine is' : 'machines are'} still at ${plant.name}. `
            + 'Move them first, or they will be placed at a site nobody can see.',
          );
        }
      }
      plant.status = status;
      plant.updatedBy = scope.userId;
      return repo.save(plant);
    });
  }

  private assertCode(code: string): void {
    if (!CODE_PATTERN.test(code ?? '')) {
      throw new BadRequestException(
        'A site code is letters, digits, dots, hyphens or underscores, up to 40 characters.',
      );
    }
  }
}
