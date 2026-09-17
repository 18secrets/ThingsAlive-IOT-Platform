import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Sensor, SensorParameterSpec } from '../entities/sensor.entity';
import { SensorCategory } from '../entities/sensor-category.entity';
import { MappedSensorRef, ToolMapping } from '../entities/tool-mapping.entity';

export interface ResolvedMappedSensor {
  sensorId: string;
  sensorName: string;
  parameters: string[];
}

export interface ResolvedToolMapping extends Omit<ToolMapping, 'mappedSensors'> {
  mappedSensors: ResolvedMappedSensor[];
}

type SensorDraft = Partial<Pick<Sensor, 'sensorName' | 'categoryId' | 'description' | 'protocol' | 'parameterSpecs'>>;
type ToolMappingDraft = Partial<Pick<ToolMapping, 'toolName' | 'industryType' | 'protocol'>> & {
  mappedSensors?: MappedSensorRef[];
};

/**
 * `draft` is a class-validator DTO: every optional field TypeScript declares is
 * defined as an own property (value `undefined`) at construction time, even when the
 * request body omitted it — an ordinary Object.assign would copy those `undefined`s
 * onto the entity and null out fields the caller never touched.
 */
function assignDefined<T extends object>(target: T, draft: Partial<T>): T {
  for (const [key, value] of Object.entries(draft)) {
    if (value !== undefined) (target as unknown as Record<string, unknown>)[key] = value;
  }
  return target;
}

/**
 * Master Admin's reference data for wiring a device before it exists (task: complete
 * the master-admin flow — Sensors, Tool Mappings, Devices).
 *
 * Flat CRUD, deliberately without the draft/publish lifecycle `CatalogAuthoringService`
 * uses: the user described this as plain reference data, not a versioned product a
 * tenant is entitled to.
 *
 * A tool mapping stores only a sensor's id, never its name — resolving it here on
 * every read means a sensor rename or a narrowed parameter list is reflected
 * everywhere it is mapped, instead of drifting from a snapshot nobody updates.
 */
@Injectable()
export class DeviceCatalogService {
  constructor(
    @InjectRepository(SensorCategory) private readonly categories: Repository<SensorCategory>,
    @InjectRepository(Sensor) private readonly sensors: Repository<Sensor>,
    @InjectRepository(ToolMapping) private readonly toolMappings: Repository<ToolMapping>,
  ) {}

  // ---- Categories -----------------------------------------------------------------

  listCategories(): Promise<SensorCategory[]> {
    return this.categories.find({ order: { name: 'ASC' } });
  }

  async createCategory(name: string): Promise<SensorCategory> {
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('A category needs a name.');
    const existing = await this.categories.findOne({ where: { name: trimmed } });
    if (existing) return existing;
    return this.categories.save(this.categories.create({ name: trimmed }));
  }

  // ---- Sensors ----------------------------------------------------------------------

  async listSensors(): Promise<Sensor[]> {
    return this.sensors.find({ order: { sensorName: 'ASC' } });
  }

  async createSensor(draft: SensorDraft): Promise<Sensor> {
    if (!draft.sensorName?.trim()) throw new BadRequestException('A sensor needs a name.');
    if (draft.categoryId) await this.requireCategory(draft.categoryId);
    return this.sensors.save(this.sensors.create({
      sensorName: draft.sensorName.trim(),
      categoryId: draft.categoryId ?? null,
      description: draft.description ?? null,
      protocol: draft.protocol ?? null,
      parameterSpecs: draft.parameterSpecs ?? [],
    }));
  }

  async updateSensor(id: string, draft: SensorDraft): Promise<Sensor> {
    const sensor = await this.sensors.findOne({ where: { id } });
    if (!sensor) throw new NotFoundException(`No sensor "${id}".`);
    if (draft.categoryId) await this.requireCategory(draft.categoryId);
    assignDefined(sensor, draft);
    return this.sensors.save(sensor);
  }

  private async requireCategory(categoryId: string): Promise<void> {
    const exists = await this.categories.findOne({ where: { id: categoryId } });
    if (!exists) throw new BadRequestException(`No sensor category "${categoryId}".`);
  }

  // ---- Tool mappings ----------------------------------------------------------------

  async listToolMappings(): Promise<ResolvedToolMapping[]> {
    const rows = await this.toolMappings.find({ order: { toolName: 'ASC' } });
    return this.resolveAll(rows);
  }

  async getToolMapping(id: string): Promise<ResolvedToolMapping> {
    const row = await this.toolMappings.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`No tool mapping "${id}".`);
    return (await this.resolveAll([row]))[0];
  }

  async createToolMapping(draft: ToolMappingDraft): Promise<ResolvedToolMapping> {
    if (!draft.toolName?.trim()) throw new BadRequestException('A tool mapping needs a name.');
    const mappedSensors = await this.requireValidMappedSensors(draft.mappedSensors ?? []);
    const saved = await this.toolMappings.save(this.toolMappings.create({
      toolName: draft.toolName.trim(),
      industryType: draft.industryType ?? null,
      protocol: draft.protocol ?? null,
      mappedSensors,
    }));
    return (await this.resolveAll([saved]))[0];
  }

  async updateToolMapping(id: string, draft: ToolMappingDraft): Promise<ResolvedToolMapping> {
    const row = await this.toolMappings.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`No tool mapping "${id}".`);
    const mappedSensors = draft.mappedSensors
      ? await this.requireValidMappedSensors(draft.mappedSensors)
      : undefined;
    assignDefined(row, { ...draft, ...(mappedSensors ? { mappedSensors } : {}) });
    const saved = await this.toolMappings.save(row);
    return (await this.resolveAll([saved]))[0];
  }

  /** Consumed by InventoryService.pool() so a registered device's tool profile shows its name. */
  async resolveToolMappingNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map();
    const rows = await this.toolMappings.find({ where: { id: In(wanted) } });
    return new Map(rows.map((r) => [r.id, r.toolName]));
  }

  /** Every referenced sensor exists, and every requested parameter is one it declares. */
  private async requireValidMappedSensors(refs: MappedSensorRef[]): Promise<MappedSensorRef[]> {
    if (!refs.length) return [];
    const ids = [...new Set(refs.map((r) => r.sensorId))];
    const rows = await this.sensors.find({ where: { id: In(ids) } });
    const byId = new Map(rows.map((s) => [s.id, s]));

    for (const ref of refs) {
      const sensor = byId.get(ref.sensorId);
      if (!sensor) throw new BadRequestException(`No sensor "${ref.sensorId}".`);
      const declared = new Set(sensor.parameterSpecs.map((p) => p.parameter));
      const unknown = ref.parameters.filter((p) => !declared.has(p));
      if (unknown.length) {
        throw new BadRequestException(
          `"${sensor.sensorName}" does not declare: ${unknown.join(', ')}.`,
        );
      }
    }
    return refs;
  }

  private async resolveAll(rows: ToolMapping[]): Promise<ResolvedToolMapping[]> {
    const ids = [...new Set(rows.flatMap((r) => r.mappedSensors.map((s) => s.sensorId)))];
    const sensors = ids.length ? await this.sensors.find({ where: { id: In(ids) } }) : [];
    const byId = new Map(sensors.map((s) => [s.id, s]));

    return rows.map((row) => ({
      ...row,
      mappedSensors: row.mappedSensors.map((ref) => ({
        sensorId: ref.sensorId,
        sensorName: byId.get(ref.sensorId)?.sensorName ?? '(deleted sensor)',
        parameters: ref.parameters,
      })),
    }));
  }
}

export type { SensorParameterSpec };
