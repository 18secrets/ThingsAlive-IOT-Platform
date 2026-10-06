import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In, QueryFailedError } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { ClientEquipmentClass } from '../../client-catalog/entities/client-equipment-class.entity';
import { ClientFormula } from '../../client-catalog/entities/client-formula.entity';
import { Plant } from '../../equipment/entities/plant.entity';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { withTenantSession } from '../../scope/tenant-session';
import { TenantParameter } from '../entities/tenant-parameter.entity';
import {
  OPERATIONAL_PARAMETERS, operationalParameter, PARAMETER_SCOPES, ParameterScope,
} from '../parameter-catalog';
import { ParameterChain, resolveParameters, ResolvedParameter } from './parameter-resolution';

export interface CatalogEntry {
  name: string;
  unit: string | null;
  kind: 'number' | 'currency_code';
  costTyped: boolean;
  description: string | null;
  source: 'operational' | 'formula';
  /** Which of this client's formulas read it — the "why does this need a value" answer. */
  requiredBy: { classSlug: string; formulaKey: string }[];
}

export interface SetParameterInput {
  scope: ParameterScope;
  scopeRef?: string | null;
  name: string;
  /** `null` clears this scope's value; the next scope up answers from then on. */
  value: unknown;
  unit?: string | null;
  effectiveFrom?: Date;
}

export interface CurrencyResult {
  currency: string | null;
  changed: boolean;
  effectiveFrom: string | null;
}

/**
 * Client parameters and cost profiles (task QPARAM1).
 *
 * Every method runs in a tenant session as `ta_app`, so row-level security decides
 * what is visible before this code does. There is no tenant-spanning method and no
 * platform read path, by design (D39) — the first check in each method refuses a
 * platform role even if one were ever granted the capability by mistake.
 */
@Injectable()
export class ParameterService {
  private readonly logger = new Logger(ParameterService.name);

  constructor(private readonly ds: DataSource) {}

  async catalog(scope: RequestScope): Promise<CatalogEntry[]> {
    this.refusePlatform(scope);
    return withTenantSession(this.ds, scope, (m) => this.loadCatalog(m, scope.tenantId));
  }

  /** Effective values at one scope, each with the row that supplied it. */
  async effective(
    scope: RequestScope, target: { scope: ParameterScope; scopeRef?: string | null }, at = new Date(),
  ): Promise<{ name: string; value: unknown; unit: string | null; source: ResolvedParameter['source'] | null }[]> {
    this.refusePlatform(scope);
    return withTenantSession(this.ds, scope, async (m) => {
      const chain = await this.chainFor(m, scope, target.scope, target.scopeRef ?? null);
      const catalog = await this.loadCatalog(m, scope.tenantId);
      const resolved = await resolveParameters(m, scope.tenantId, chain, catalog.map((c) => c.name), at);
      return catalog.map((entry) => {
        const r = resolved.get(entry.name) ?? null;
        return { name: entry.name, value: r?.value ?? null, unit: r?.unit ?? entry.unit, source: r?.source ?? null };
      });
    });
  }

  /** Every row for a name, newest first — clears included, because a clear is a decision. */
  async history(
    scope: RequestScope, name: string, target?: { scope?: ParameterScope; scopeRef?: string | null },
  ): Promise<TenantParameter[]> {
    this.refusePlatform(scope);
    return withTenantSession(this.ds, scope, async (m) => {
      const qb = m.getRepository(TenantParameter).createQueryBuilder('p')
        .where('p.tenantId = :tenantId', { tenantId: scope.tenantId })
        .andWhere('p.name = :name', { name });
      if (target?.scope) {
        await this.chainFor(m, scope, target.scope, target.scopeRef ?? null);
        qb.andWhere('p.scope = :scope', { scope: target.scope });
        if (target.scope !== 'client') qb.andWhere('p.scopeRef = :ref', { ref: target.scopeRef });
      }
      const rows = await qb.orderBy('p.effectiveFrom', 'DESC').addOrderBy('p.createdAt', 'DESC').getMany();
      return this.visibleRows(m, scope, rows);
    });
  }

  async set(scope: RequestScope, input: SetParameterInput): Promise<TenantParameter> {
    this.refusePlatform(scope);
    if (input.name === 'currency') {
      throw new BadRequestException('Change the currency through POST /parameters/currency, which checks for cost values.');
    }
    const scopeRef = input.scope === 'client' ? null : (input.scopeRef ?? null);
    return withTenantSession(this.ds, scope, async (m) => {
      await this.chainFor(m, scope, input.scope, scopeRef);
      const catalog = await this.loadCatalog(m, scope.tenantId);
      const entry = catalog.find((c) => c.name === input.name);
      if (!entry) {
        throw new BadRequestException(
          `"${input.name}" is not a parameter any formula or the platform declares (unknown_parameter). `
            + 'Values for unknown names are refused rather than stored where nothing will read them.',
        );
      }
      if (input.value !== null && typeof input.value !== 'number') {
        throw new BadRequestException(`"${input.name}" takes a number, or null to clear it.`);
      }
      if (entry.source === 'operational' && input.unit != null && input.unit !== entry.unit) {
        throw new BadRequestException(`"${input.name}" is measured in "${entry.unit}", not "${input.unit}".`);
      }
      const unit = entry.source === 'operational' ? entry.unit : (input.unit ?? null);
      const saved = await this.insert(m, {
        tenantId: scope.tenantId, scope: input.scope, scopeRef, name: input.name,
        value: input.value, unit, effectiveFrom: input.effectiveFrom ?? new Date(), createdBy: scope.userId,
      });
      this.logger.log(
        `${scope.userId} ${input.value === null ? 'cleared' : 'set'} "${input.name}" at ${input.scope}`
          + `${scopeRef ? ` ${scopeRef}` : ''} from ${saved.effectiveFrom.toISOString()}.`,
      );
      return saved;
    });
  }

  /**
   * §0.3. Refused while any cost-typed value exists, naming how many and where — the
   * client clears them deliberately, each clear a row of its own. Re-stating the
   * current currency is a no-op, so a retried request does not write twice.
   */
  async setCurrency(scope: RequestScope, currency: string | null, effectiveFrom = new Date()): Promise<CurrencyResult> {
    this.refusePlatform(scope);
    if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException('currency must be an ISO 4217 code such as "INR" or "USD", or null.');
    }
    return withTenantSession(this.ds, scope, async (m) => {
      // The same lock the database's guard takes, taken first so the read below
      // cannot be overtaken by a concurrent write between reading and inserting.
      await m.query(`SELECT pg_advisory_xact_lock(hashtext('tenant_parameter:' || $1))`, [scope.tenantId]);
      const current = await m.getRepository(TenantParameter).findOne({
        where: { tenantId: scope.tenantId, scope: 'client', name: 'currency' },
        order: { effectiveFrom: 'DESC' },
      });
      const currentValue = (current?.value ?? null) as string | null;
      if (current && currentValue === currency) {
        return { currency, changed: false, effectiveFrom: current.effectiveFrom.toISOString() };
      }
      if (currentValue !== null) {
        const inForce: { scope: string; values_count: string }[] = await m.query(
          `SELECT "scope", "values_count" FROM "tenant_parameter_cost_values"($1)`, [scope.tenantId],
        );
        if (inForce.length) {
          const total = inForce.reduce((n, r) => n + Number(r.values_count), 0);
          throw new ConflictException(
            `Cannot change the currency from ${currentValue} while ${total} cost value(s) exist `
              + `(${inForce.map((r) => `${r.values_count} at ${r.scope}`).join(', ')}). `
              + `Clear them first — there is no conversion (currency_conflict).`,
          );
        }
      }
      const saved = await this.insert(m, {
        tenantId: scope.tenantId, scope: 'client', scopeRef: null, name: 'currency',
        value: currency, unit: null, effectiveFrom, createdBy: scope.userId,
      });
      this.logger.warn(`${scope.userId} changed the currency from ${currentValue ?? 'unset'} to ${currency ?? 'unset'}.`);
      return { currency, changed: true, effectiveFrom: saved.effectiveFrom.toISOString() };
    });
  }

  // --------------------------------------------------------------------------------

  private refusePlatform(scope: RequestScope): void {
    if (scope.isPlatformRole) {
      throw new ForbiddenException('Client parameters have no platform access path (D39).');
    }
  }

  private async insert(m: EntityManager, row: Omit<TenantParameter, 'id' | 'createdAt'>): Promise<TenantParameter> {
    // jsonb null is a value here, not an absent column: stored as the JSON literal so
    // "cleared" and "never set" stay different facts.
    const [inserted] = await m.query(
      `INSERT INTO "tenant_parameter"
         ("tenant_id", "scope", "scope_ref", "name", "value", "unit", "effective_from", "created_by")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING "id"`,
      [row.tenantId, row.scope, row.scopeRef, row.name, JSON.stringify(row.value),
        row.unit, row.effectiveFrom, row.createdBy],
    ).catch(mapWriteError);
    return m.getRepository(TenantParameter).findOneByOrFail({ id: inserted.id });
  }

  private async loadCatalog(m: EntityManager, tenantId: string): Promise<CatalogEntry[]> {
    const formulas = await m.getRepository(ClientFormula).find({
      where: { tenantId, status: 'active' },
      select: { clientEquipmentClassSlug: true, formulaKey: true, requiredParameters: true },
    });
    const requiredBy = new Map<string, { classSlug: string; formulaKey: string }[]>();
    for (const f of formulas) {
      for (const p of f.requiredParameters) {
        const list = requiredBy.get(p) ?? [];
        list.push({ classSlug: f.clientEquipmentClassSlug, formulaKey: f.formulaKey });
        requiredBy.set(p, list);
      }
    }
    const entries: CatalogEntry[] = OPERATIONAL_PARAMETERS.map((p) => ({
      ...p, source: 'operational' as const, requiredBy: requiredBy.get(p.name) ?? [],
    }));
    for (const [name, list] of [...requiredBy].sort(([a], [b]) => a.localeCompare(b))) {
      if (operationalParameter(name)) continue;
      entries.push({
        name, unit: null, kind: 'number', costTyped: false, description: null, source: 'formula', requiredBy: list,
      });
    }
    return entries;
  }

  /**
   * The resolution chain for a scope, after checking the ref exists in this account
   * and is one this caller may see. A plant- or equipment-scoped role reads only its
   * own sites and machines; client and class values are account-wide.
   */
  private async chainFor(
    m: EntityManager, scope: RequestScope, target: ParameterScope, ref: string | null,
  ): Promise<ParameterChain> {
    if (!PARAMETER_SCOPES.includes(target)) {
      throw new BadRequestException(`scope must be one of ${PARAMETER_SCOPES.join(', ')}.`);
    }
    if (target === 'client') return {};
    if (!ref) throw new BadRequestException(`A ${target} value needs a scopeRef.`);

    if (target === 'site') {
      const plant = isUuid(ref) ? await m.getRepository(Plant).findOne({ where: { tenantId: scope.tenantId, id: ref } }) : null;
      if (!plant || (scope.plantIds && !scope.plantIds.includes(plant.id))) {
        throw new NotFoundException(`No site "${ref}" in this account.`);
      }
      return { site: plant.id };
    }
    if (target === 'equipment_class') {
      const cls = await m.getRepository(ClientEquipmentClass).findOne({ where: { tenantId: scope.tenantId, slug: ref } });
      if (!cls) throw new NotFoundException(`No equipment class "${ref}" in this account.`);
      return { equipment_class: cls.slug };
    }
    const profile = isUuid(ref)
      ? await m.getRepository(EquipmentProfile).findOne({ where: { tenantId: scope.tenantId, id: ref } })
      : null;
    if (!profile || !this.canSeeEquipment(scope, profile)) {
      throw new NotFoundException(`No equipment "${ref}" in this account.`);
    }
    return { equipment: profile.id, equipment_class: profile.equipmentClassSlug, site: profile.plantId };
  }

  private canSeeEquipment(scope: RequestScope, profile: EquipmentProfile): boolean {
    if (scope.equipmentIds && !scope.equipmentIds.includes(profile.externalId)) return false;
    if (scope.plantIds && !(profile.plantId && scope.plantIds.includes(profile.plantId))) return false;
    return true;
  }

  /** History rows at a site or machine the caller is not assigned to are not theirs to read. */
  private async visibleRows(m: EntityManager, scope: RequestScope, rows: TenantParameter[]): Promise<TenantParameter[]> {
    if (!scope.plantIds && !scope.equipmentIds) return rows;
    const equipmentRefs = [...new Set(rows.filter((r) => r.scope === 'equipment').map((r) => r.scopeRef!))];
    const profiles = equipmentRefs.length
      ? await m.getRepository(EquipmentProfile).find({ where: { tenantId: scope.tenantId, id: In(equipmentRefs) } })
      : [];
    const visibleEquipment = new Set(profiles.filter((p) => this.canSeeEquipment(scope, p)).map((p) => p.id));
    return rows.filter((r) => {
      if (r.scope === 'equipment') return visibleEquipment.has(r.scopeRef!);
      if (r.scope === 'site' && scope.plantIds) return scope.plantIds.includes(r.scopeRef!);
      return true;
    });
  }
}

/** The database's refusals, said in the API's terms rather than as a 500. */
function mapWriteError(error: unknown): never {
  if (error instanceof QueryFailedError) {
    const code = (error as QueryFailedError & { code?: string }).code;
    if (/\(currency_conflict\)/.test(error.message)) throw new ConflictException(error.message);
    if (code === '23505') {
      throw new ConflictException('A value for this parameter, scope and effective time already exists. Use a later effectiveFrom.');
    }
    if (code === '23514') throw new BadRequestException(`Refused by the database: ${error.message}`);
  }
  throw error;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
