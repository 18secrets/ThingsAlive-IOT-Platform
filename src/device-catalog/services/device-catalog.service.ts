import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, QueryFailedError, Repository } from 'typeorm';
import { Sensor, SensorParameterSpec } from '../entities/sensor.entity';
import { SensorCategory } from '../entities/sensor-category.entity';
import { MappedSensorRef, ToolMapping } from '../entities/tool-mapping.entity';
import { IndustryType, IndustryTypeStatus } from '../entities/industry-type.entity';
import { slugify } from '../../catalog-import/services/sensor-review';
import { assignDefined } from '../../common/assign-defined';
import { rethrowDeleteRefusal } from '../../identity/delete-refusal';
import { retiredSensorProblem } from './sensor-retirement';

export interface ResolvedMappedSensor {
  sensorId: string;
  sensorName: string;
  parameters: string[];
}

export interface ResolvedToolMapping extends Omit<ToolMapping, 'mappedSensors'> {
  mappedSensors: ResolvedMappedSensor[];
  /** The type's name, resolved on read, so a table that shows a name keeps showing one. */
  industryType: string | null;
}

type SensorDraft = Partial<Pick<Sensor, 'sensorName' | 'categoryId' | 'description' | 'protocol' | 'parameterSpecs'>>;
type ToolMappingDraft = Partial<Pick<ToolMapping, 'toolName' | 'protocol' | 'industryTypeId'>> & {
  mappedSensors?: MappedSensorRef[];
  /** Transitional (§7 Q6): text accepted only when it names one active type exactly. */
  industryType?: string;
};

export interface IndustryTypeDraft { name?: string; code?: string; status?: IndustryTypeStatus }

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

  /** Live categories only, unless asked — a retired one is not somewhere to file a sensor. */
  listCategories(includeRetired = false): Promise<SensorCategory[]> {
    return this.categories.find({
      where: includeRetired ? {} : { retiredAt: IsNull() },
      order: { name: 'ASC' },
    });
  }

  /**
   * Re-adding a retired category's name is refused rather than handed back. Returning
   * it would look like success, and the next sensor filed under it would then be
   * refused by the database with no hint why.
   */
  async createCategory(name: string): Promise<SensorCategory> {
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('A category needs a name.');
    const existing = await this.categories.findOne({ where: { name: trimmed } });
    if (existing?.retiredAt) {
      throw new BadRequestException(
        `Category "${trimmed}" exists but was retired on ${day(existing.retiredAt)}; un-retire it instead.`,
      );
    }
    if (existing) return existing;
    return this.categories.save(this.categories.create({ name: trimmed }));
  }

  async retireCategory(id: string, userId: string): Promise<SensorCategory> {
    return this.retire(this.categories, 'sensor_category', 'category', id, userId);
  }

  async unretireCategory(id: string): Promise<SensorCategory> {
    return this.unretire(this.categories, 'sensor_category', 'category', id);
  }

  async deleteSensor(id: string): Promise<void> {
    return this.deleteUnused(id, false);
  }

  async deleteCategory(id: string): Promise<void> {
    return this.deleteUnused(id, true);
  }

  private async deleteUnused(id: string, category: boolean): Promise<void> {
    const label = category ? 'category' : 'sensor';
    if (!UUID.test(id)) throw new NotFoundException(`No ${label} "${id}".`);
    const [result] = await this.translateRefusal(() => this.sensors.query(
      'SELECT delete_unused_sensor($1::uuid, $2::boolean) AS deleted', [id, category],
    ));
    if (!result.deleted) throw new NotFoundException(`No ${label} "${id}".`);
  }

  // ---- Sensors ----------------------------------------------------------------------

  /**
   * The picker list: live sensors only, unless asked. Retired ones still resolve by id
   * everywhere they are already used — this hides them from new work, nothing more.
   */
  async listSensors(includeRetired = false): Promise<Sensor[]> {
    return this.sensors.find({
      where: includeRetired ? {} : { retiredAt: IsNull() },
      order: { sensorName: 'ASC' },
    });
  }

  async retireSensor(id: string, userId: string): Promise<Sensor> {
    return this.retire(this.sensors, 'sensor', 'sensor', id, userId);
  }

  /** Allowed: retiring is a correction, and corrections have their own mistakes. */
  async unretireSensor(id: string): Promise<Sensor> {
    return this.unretire(this.sensors, 'sensor', 'sensor', id);
  }

  /**
   * Idempotent, and atomically so. The `retired_at IS NULL` guard is in the UPDATE
   * itself rather than read first: two concurrent retires would otherwise both see a
   * live row and the second would overwrite who retired it and when. Retiring an
   * already-retired row keeps the original record.
   */
  private async retire<T extends { retiredAt: Date | null }>(
    repo: Repository<T>, table: string, label: string, id: string, userId: string,
  ): Promise<T> {
    await this.translateRefusal(() => repo.query(
      `UPDATE "${table}" SET "retired_at" = now(), "retired_by" = $2
        WHERE "id" = $1 AND "retired_at" IS NULL`,
      [id, userId],
    ));
    return this.reload(repo, label, id);
  }

  private async unretire<T extends { retiredAt: Date | null }>(
    repo: Repository<T>, table: string, label: string, id: string,
  ): Promise<T> {
    await this.translateRefusal(() => repo.query(
      `UPDATE "${table}" SET "retired_at" = NULL, "retired_by" = NULL
        WHERE "id" = $1 AND "retired_at" IS NOT NULL`,
      [id],
    ));
    return this.reload(repo, label, id);
  }

  private async reload<T>(repo: Repository<T>, label: string, id: string): Promise<T> {
    if (!UUID.test(id)) throw new NotFoundException(`No ${label} "${id}".`);
    const row = await repo.findOne({ where: { id } as any });
    if (!row) throw new NotFoundException(`No ${label} "${id}".`);
    return row;
  }

  /**
   * The category rules live in triggers (`1758410000000-SensorRetirement.ts`), so the
   * refusal arrives as a database error. It is the caller's mistake, not a fault, and
   * its message already names what to fix — passed through as a 400.
   */
  private async translateRefusal<R>(fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof QueryFailedError && /\((ck_sensor_category_(live|retire_empty)|sensor_referenced|sensor_retired|sensor_reference)\)/.test(err.message)) {
        throw new BadRequestException(err.message);
      }
      if (err instanceof QueryFailedError && /invalid input syntax for type uuid/.test(err.message)) {
        return undefined as R;
      }
      throw err;
    }
  }

  async createSensor(draft: SensorDraft): Promise<Sensor> {
    if (!draft.sensorName?.trim()) throw new BadRequestException('A sensor needs a name.');
    if (draft.categoryId) await this.requireCategory(draft.categoryId);
    const sensorName = draft.sensorName.trim();
    const slug = await this.uniqueSlugFor(draft.sensorName);
    return this.translateRefusal(() => this.sensors.save(this.sensors.create({
      sensorName,
      slug,
      categoryId: draft.categoryId ?? null,
      description: draft.description ?? null,
      protocol: draft.protocol ?? null,
      parameterSpecs: draft.parameterSpecs ?? [],
    })));
  }

  /** The same derivation `sensor-review.ts` uses for a proposed sensor (task
   * QIMP5) — this is the only other place a `sensor` row is ever created, and the
   * two paths writing different slugs for the same name would be the exact
   * problem `slug` exists to close. A collision gets a numeric suffix, same as the
   * migration's one-time backfill. */
  private async uniqueSlugFor(name: string): Promise<string> {
    const base = slugify(name);
    let candidate = base;
    let suffix = 1;
    // Vanishingly few sensors share a base slug; a loop beats a recursive query.
    // eslint-disable-next-line no-await-in-loop
    while (await this.sensors.findOne({ where: { slug: candidate } })) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    return candidate;
  }

  async updateSensor(id: string, draft: SensorDraft): Promise<Sensor> {
    const sensor = await this.sensors.findOne({ where: { id } });
    if (!sensor) throw new NotFoundException(`No sensor "${id}".`);
    if (draft.categoryId) await this.requireCategory(draft.categoryId);
    assignDefined(sensor, draft);
    return this.translateRefusal(() => this.sensors.save(sensor));
  }

  /**
   * Checked here for a readable message; the trigger is what actually guarantees it,
   * since a category can be retired between this read and the write.
   */
  private async requireCategory(categoryId: string): Promise<void> {
    const category = await this.categories.findOne({ where: { id: categoryId } });
    if (!category) throw new BadRequestException(`No sensor category "${categoryId}".`);
    if (category.retiredAt) {
      throw new BadRequestException(
        `Sensor category "${category.name}" was retired on ${day(category.retiredAt)}.`,
      );
    }
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
    const mappedSensors = await this.requireValidMappedSensors(draft.mappedSensors ?? [], []);
    const saved = await this.toolMappings.save(this.toolMappings.create({
      toolName: draft.toolName.trim(),
      industryTypeId: await this.chosenIndustry(draft) ?? null,
      protocol: draft.protocol ?? null,
      mappedSensors,
    }));
    return (await this.resolveAll([saved]))[0];
  }

  async updateToolMapping(id: string, draft: ToolMappingDraft): Promise<ResolvedToolMapping> {
    const row = await this.toolMappings.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`No tool mapping "${id}".`);
    const mappedSensors = draft.mappedSensors
      ? await this.requireValidMappedSensors(draft.mappedSensors, row.mappedSensors)
      : undefined;
    const industryTypeId = draft.industryTypeId !== undefined || draft.industryType !== undefined
      ? await this.chosenIndustry(draft) : undefined;
    const { industryType: _text, ...fields } = draft;
    void _text;
    assignDefined(row, { ...fields, industryTypeId, ...(mappedSensors ? { mappedSensors } : {}) });
    const saved = await this.toolMappings.save(row);
    return (await this.resolveAll([saved]))[0];
  }

  /**
   * Remove a tool mapping no device uses (dashboard testing, issue 6). A device still
   * pointing at it makes the database refuse (`fk_device_inventory_tool_mapping`):
   * those devices belong to clients and sit behind row-level security, so a count
   * taken here would read none and allow the delete anyway.
   */
  async deleteToolMapping(id: string): Promise<void> {
    if (!UUID.test(id)) throw new NotFoundException(`No tool mapping "${id}".`);
    const [row] = await this.toolMappings.query('SELECT delete_unused_tool_mapping($1::uuid) AS deleted', [id])
      .catch((err: unknown) => rethrowDeleteRefusal(
        err, 'Devices are still registered with this tool mapping. Move them to another mapping first.',
      ));
    if (!row.deleted) throw new NotFoundException(`No tool mapping "${id}".`);
  }

  /** Consumed by InventoryService.pool() so a registered device's tool profile shows its name. */
  async resolveToolMappingNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map();
    const rows = await this.toolMappings.find({ where: { id: In(wanted) } });
    return new Map(rows.map((r) => [r.id, r.toolName]));
  }

  /**
   * Every referenced sensor exists, every requested parameter is one it declares, and
   * none is retired — unless the mapping already held it. A mapping that has carried a
   * sensor since before it was retired keeps it through an unrelated edit; refusing
   * would make the whole mapping uneditable over a sensor nobody is adding.
   */
  private async requireValidMappedSensors(
    refs: MappedSensorRef[], alreadyMapped: MappedSensorRef[],
  ): Promise<MappedSensorRef[]> {
    if (!refs.length) return [];
    const ids = [...new Set(refs.map((r) => r.sensorId))];
    const rows = await this.sensors.find({ where: { id: In(ids) } });
    const byId = new Map(rows.map((s) => [s.id, s]));

    for (const ref of refs) {
      const sensor = byId.get(ref.sensorId);
      if (!sensor) throw new BadRequestException(`No sensor "${ref.sensorId}".`);
      const retired = retiredSensorProblem(sensor);
      if (retired && !alreadyMapped.some((m) => m.sensorId === sensor.id)) {
        throw new BadRequestException(retired);
      }
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

  // ---- Industry types (task QINDUSTRY) -----------------------------------------------

  /** Reached through the tool mappings' manager rather than injected, so every caller
   * that constructs this service with its three repositories keeps working. */
  private get industries() { return this.toolMappings.manager.getRepository(IndustryType); }

  listIndustryTypes(status?: IndustryTypeStatus): Promise<IndustryType[]> {
    return this.industries.find({ where: status ? { status } : {}, order: { name: 'ASC' } });
  }

  async createIndustryType(draft: IndustryTypeDraft, by: string): Promise<IndustryType> {
    return this.saveIndustry(this.industries.create({
      name: draft.name?.trim() ?? '', code: draft.code?.trim().toUpperCase() ?? '',
      status: draft.status ?? 'active', createdBy: by, updatedBy: by,
    }));
  }

  async updateIndustryType(id: string, draft: IndustryTypeDraft, by: string): Promise<IndustryType> {
    const row = UUID.test(id) ? await this.industries.findOne({ where: { id } }) : null;
    if (!row) throw new NotFoundException(`No industry type "${id}".`);
    assignDefined(row, {
      name: draft.name?.trim(), code: draft.code?.trim().toUpperCase(), status: draft.status, updatedBy: by,
    });
    return this.saveIndustry(row);
  }

  /** Refused by the foreign key while a mapping points at it; the 409 says how many. */
  async deleteIndustryType(id: string): Promise<void> {
    const row = UUID.test(id) ? await this.industries.findOne({ where: { id } }) : null;
    if (!row) throw new NotFoundException(`No industry type "${id}".`);
    try {
      await this.industries.delete({ id });
    } catch (err) {
      if (err instanceof QueryFailedError && (err as { code?: string }).code === '23503') {
        const n = await this.toolMappings.count({ where: { industryTypeId: id } });
        throw new ConflictException(
          `"${row.name}" is used by ${n} tool mapping(s). Make it inactive instead, or move them first.`,
        );
      }
      throw err;
    }
  }

  /** §2 step 2: the text that matched no type, with how many mappings carry it. */
  async unmatchedIndustries(): Promise<{ text: string; mappings: number }[]> {
    const rows: { text: string; mappings: number }[] = await this.toolMappings.query(
      `SELECT btrim("industry_type_legacy") AS text, count(*)::int AS mappings
         FROM "tool_mapping"
        WHERE "industry_type_id" IS NULL AND coalesce(btrim("industry_type_legacy"), '') <> ''
        GROUP BY 1 ORDER BY 2 DESC, 1`,
    );
    return rows;
  }

  /**
   * Match the unmatched again, after Master Admin has created the types they name — the
   * migration's own rule: exactly one active type, by name or code, ignoring case.
   * Only ever fills an empty `industry_type_id`; it never moves a mapping already set.
   */
  async rematchIndustries(): Promise<{ matched: number; unmatched: number }> {
    const [{ matched }] = await this.toolMappings.query(
      `WITH candidates AS (
         SELECT m."id" AS mapping_id, t."id" AS type_id, count(*) OVER (PARTITION BY m."id") AS n
           FROM "tool_mapping" m
           JOIN "industry_type" t
             ON t."status" = 'active'
            AND lower(btrim(m."industry_type_legacy")) IN (lower(t."name"), lower(t."code"))
          WHERE m."industry_type_id" IS NULL
       ), applied AS (
         UPDATE "tool_mapping" m SET "industry_type_id" = c.type_id
           FROM candidates c WHERE c.mapping_id = m."id" AND c.n = 1
         RETURNING m."id"
       )
       SELECT count(*)::int AS matched FROM applied`,
    );
    const unmatched = (await this.unmatchedIndustries()).reduce((s, r) => s + r.mappings, 0);
    return { matched, unmatched };
  }

  /**
   * The type a write chooses: `industryTypeId`, which must be active, or — while the
   * console still sends text (§7 Q6) — text naming exactly one active type by name or
   * code. Anything else is a 400 naming the active types; nothing new lands in free text.
   * `null` clears it.
   */
  private async chosenIndustry(draft: ToolMappingDraft): Promise<string | null | undefined> {
    if (draft.industryTypeId === null) return null;
    const active = await this.industries.find({ where: { status: 'active' }, order: { name: 'ASC' } });
    const names = () => active.map((t) => `${t.name} (${t.code})`).join(', ') || 'none yet';
    let chosen: IndustryType | undefined;
    if (draft.industryTypeId !== undefined) {
      chosen = active.find((t) => t.id === draft.industryTypeId);
      if (!chosen) throw new BadRequestException(`industryTypeId must name an active industry type: ${names()}.`);
    }
    if (draft.industryType !== undefined && draft.industryType.trim() !== '') {
      const text = draft.industryType.trim().toLowerCase();
      const byText = active.filter((t) => t.name.toLowerCase() === text || t.code.toLowerCase() === text);
      if (byText.length !== 1) {
        throw new BadRequestException(`"${draft.industryType}" is not an active industry type. Choose one of: ${names()}.`);
      }
      if (chosen && chosen.id !== byText[0].id) {
        throw new BadRequestException('industryTypeId and industryType name different industry types.');
      }
      chosen = byText[0];
    }
    return chosen?.id;
  }

  private async saveIndustry(row: IndustryType): Promise<IndustryType> {
    try {
      return await this.industries.save(row);
    } catch (err) {
      const pg = err as { code?: string; constraint?: string };
      if (err instanceof QueryFailedError && pg.code === '23505') {
        throw new ConflictException(pg.constraint === 'uq_industry_type_code'
          ? `An industry type already has code "${row.code}".`
          : `An industry type is already called "${row.name}" (in some spelling).`);
      }
      if (err instanceof QueryFailedError && pg.code === '23514') {
        throw new BadRequestException(pg.constraint === 'ck_industry_type_code'
          ? 'code must be 2–10 uppercase letters or digits.'
          : pg.constraint === 'ck_industry_type_status' ? 'status must be active or inactive.'
            : 'An industry type needs a name.');
      }
      throw err;
    }
  }

  private async resolveAll(rows: ToolMapping[]): Promise<ResolvedToolMapping[]> {
    const ids = [...new Set(rows.flatMap((r) => r.mappedSensors.map((s) => s.sensorId)))];
    const sensors = ids.length ? await this.sensors.find({ where: { id: In(ids) } }) : [];
    const byId = new Map(sensors.map((s) => [s.id, s]));
    const typeIds = [...new Set(rows.map((r) => r.industryTypeId).filter((x): x is string => !!x))];
    const types = typeIds.length ? await this.industries.find({ where: { id: In(typeIds) } }) : [];
    const typeById = new Map(types.map((t) => [t.id, t.name]));

    return rows.map((row) => ({
      ...row,
      industryType: row.industryTypeId ? typeById.get(row.industryTypeId) ?? null : null,
      mappedSensors: row.mappedSensors.map((ref) => ({
        sensorId: ref.sensorId,
        sensorName: byId.get(ref.sensorId)?.sensorName ?? '(deleted sensor)',
        parameters: ref.parameters,
      })),
    }));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const day = (at: Date) => at.toISOString().slice(0, 10);

export type { SensorParameterSpec };
