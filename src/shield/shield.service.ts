import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In, QueryFailedError } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { ParameterRow, ResolvedParameter, chainForEquipment, resolveFromRows } from '../parameters/services/parameter-resolution';
import { withTenantSession } from '../scope/tenant-session';
import { SHIELD_CATEGORIES, ShieldCategory, ShieldEvidenceRecord, ShieldResult } from './shield-evidence-record.entity';

export const DUE_SOON_PARAMETER = 'shield_due_soon_days';
/** Ours, not a customer's policy — which is why it is a parameter from day one, and why
 * every answer says which window it used (QSHIELD1 §7 Q2). */
export const DEFAULT_DUE_SOON_DAYS = 30;

export type ShieldStatus = 'action_required' | 'overdue' | 'due_soon' | 'current' | 'not_recorded';
const STATUSES: readonly ShieldStatus[] = ['action_required', 'overdue', 'due_soon', 'current', 'not_recorded'];

export interface EvidenceInput {
  title: string;
  result: ShieldResult;
  performedAt: Date;
  dueAt?: Date | null;
  ownerUserId?: string | null;
  ownerName?: string | null;
  reference?: string | null;
  findings?: string | null;
}

export interface EvidenceView {
  id: string;
  category: ShieldCategory;
  title: string;
  result: ShieldResult;
  performedAt: string;
  dueAt: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  reference: string | null;
  findings: string | null;
  recordedBy: string;
  recordedAt: string;
  supersedesId: string | null;
  /** The record that corrected this one; null while it stands. */
  supersededById: string | null;
}

export interface DueSoonWindow {
  days: number;
  /** `default` when no parameter is set at any scope for this machine. */
  source: 'parameter' | 'default';
  parameter: ResolvedParameter['source'] | null;
}

export interface CategoryStatus {
  status: ShieldStatus;
  /** The record the status was read from; null exactly when `not_recorded`. */
  record: EvidenceView | null;
}

export interface MachineShield {
  machine: { sourceSystem: string; externalId: string; name: string | null; classSlug: string | null; plantId: string | null };
  dueSoonWindow: DueSoonWindow;
  categories: Record<ShieldCategory, CategoryStatus>;
}

export interface ShieldSummary {
  asOf: string;
  /** Over every (machine, category) cell — a machine with nothing recorded counts three
   * times under `not_recorded`, because that is three checks nobody can show. */
  counts: Record<ShieldStatus, number>;
  machines: MachineShield[];
}

/**
 * ThingsShield evidence (task QSHIELD1): what was checked on a machine, what was found,
 * and when the next one is due.
 *
 * The status is computed here at read time and never stored. Missing evidence reads
 * `not_recorded`, never `current` — a machine nobody has inspected must not look like
 * one that passed (G04).
 *
 * Visibility is the work-order rule: the tenant, narrowed by `scope.equipmentIds`. A
 * machine outside it is a 404, the same answer as one that does not exist, so the
 * response does not confirm what the caller may not see.
 */
@Injectable()
export class ShieldService {
  private readonly logger = new Logger(ShieldService.name);

  constructor(private readonly ds: DataSource) {}

  async summary(scope: RequestScope, now = new Date()): Promise<ShieldSummary> {
    return withTenantSession(this.ds, scope, async (m) => {
      const where: Record<string, unknown> = { tenantId: scope.tenantId };
      if (scope.equipmentIds !== undefined) {
        if (scope.equipmentIds.length === 0) return emptySummary(now);
        where.externalId = In([...scope.equipmentIds]);
      }
      const profiles = await m.getRepository(EquipmentProfile).find({ where, order: { externalId: 'ASC' } });
      if (!profiles.length) return emptySummary(now);

      const records = await m.getRepository(ShieldEvidenceRecord).find({
        where: { tenantId: scope.tenantId, externalId: In(profiles.map((p) => p.externalId)) },
      });
      const windowRows = await dueSoonRows(m, scope.tenantId, now);

      const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ShieldStatus, number>;
      const machines = profiles.map((p): MachineShield => {
        const mine = records.filter((r) => r.sourceSystem === p.sourceSystem && r.externalId === p.externalId);
        const window = dueSoonWindow(windowRows, p);
        const categories = {} as Record<ShieldCategory, CategoryStatus>;
        for (const category of SHIELD_CATEGORIES) {
          const cell = categoryStatus(mine.filter((r) => r.category === category), window.days, now);
          counts[cell.status] += 1;
          categories[category] = cell;
        }
        return {
          machine: {
            sourceSystem: p.sourceSystem, externalId: p.externalId,
            name: p.name ?? null, classSlug: p.equipmentClassSlug ?? null, plantId: p.plantId ?? null,
          },
          dueSoonWindow: window,
          categories,
        };
      });
      return { asOf: now.toISOString(), counts, machines };
    });
  }

  /** Every record on the machine, corrected ones included and marked — newest check first. */
  async records(scope: RequestScope, sourceSystem: string, externalId: string): Promise<EvidenceView[]> {
    return withTenantSession(this.ds, scope, async (m) => {
      await this.machine(m, scope, sourceSystem, externalId);
      const rows = await m.getRepository(ShieldEvidenceRecord).find({
        where: { tenantId: scope.tenantId, sourceSystem, externalId },
        order: { performedAt: 'DESC', createdAt: 'DESC' },
      });
      return withSupersession(rows);
    });
  }

  async record(
    scope: RequestScope, sourceSystem: string, externalId: string,
    category: ShieldCategory, input: EvidenceInput, now = new Date(),
  ): Promise<EvidenceView> {
    checkInput(input, now);
    if (!SHIELD_CATEGORIES.includes(category)) {
      throw new BadRequestException(`category must be one of ${SHIELD_CATEGORIES.join(', ')}.`);
    }
    const saved = await withTenantSession(this.ds, scope, async (m) => {
      await this.machine(m, scope, sourceSystem, externalId);
      return insert(m, {
        tenantId: scope.tenantId, sourceSystem, externalId, category,
        ...fields(input), recordedBy: scope.userId, supersedesId: null,
      });
    }).catch(mapWriteError);
    this.logger.log(`${scope.userId} recorded ${category} evidence ${saved.id} on ${sourceSystem}/${externalId}.`);
    return view(saved, null);
  }

  /**
   * A correction: a new record that supersedes `id`, on the same machine and category.
   *
   * Idempotent on `id` for a retry. The same caller sending the same correction again
   * gets the revision that already exists; anyone sending a different one gets a 409
   * naming it, because two different corrections of one check cannot both be the truth
   * and silently keeping either would hide the other. The unique index on
   * `supersedes_id` decides the race — the row cannot be locked, since `ta_app` holds no
   * UPDATE grant on an append-only table.
   */
  async revise(scope: RequestScope, id: string, input: EvidenceInput, now = new Date()): Promise<EvidenceView> {
    checkInput(input, now);
    if (!isUuid(id)) throw new NotFoundException('No such evidence record in this account.');

    const attempt = await withTenantSession(this.ds, scope, async (m) => {
      const target = await m.getRepository(ShieldEvidenceRecord).findOne({ where: { tenantId: scope.tenantId, id } });
      if (!target) throw new NotFoundException('No such evidence record in this account.');
      await this.machine(m, scope, target.sourceSystem, target.externalId);
      const existing = await m.getRepository(ShieldEvidenceRecord).findOne({ where: { tenantId: scope.tenantId, supersedesId: id } });
      if (existing) return { existing };
      const saved = await insert(m, {
        tenantId: scope.tenantId, sourceSystem: target.sourceSystem, externalId: target.externalId,
        category: target.category, ...fields(input), recordedBy: scope.userId, supersedesId: id,
      });
      return { saved };
    }).catch((error: unknown) => {
      if (isUniqueViolation(error, 'uq_shield_evidence_supersedes')) return { lostRace: true as const };
      return mapWriteError(error);
    });

    if ('saved' in attempt && attempt.saved) {
      this.logger.log(`${scope.userId} revised evidence ${id} as ${attempt.saved.id}.`);
      return view(attempt.saved, null);
    }
    // Lost the race, or arrived after it: read the winner in a fresh transaction —
    // the one that hit the unique violation is aborted and can answer nothing.
    const existing = 'existing' in attempt && attempt.existing
      ? attempt.existing
      : await withTenantSession(this.ds, scope, (m) =>
        m.getRepository(ShieldEvidenceRecord).findOneOrFail({ where: { tenantId: scope.tenantId, supersedesId: id } }));
    if (existing.recordedBy === scope.userId && sameContent(existing, input)) return view(existing, null);
    throw new ConflictException(
      `Evidence record ${id} has already been revised by record ${existing.id}. Revise that one instead.`,
    );
  }

  private async machine(m: EntityManager, scope: RequestScope, sourceSystem: string, externalId: string): Promise<EquipmentProfile> {
    const notFound = () => new NotFoundException('No such machine in this account.');
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(externalId)) throw notFound();
    const profile = await m.getRepository(EquipmentProfile).findOne({
      where: { tenantId: scope.tenantId, sourceSystem, externalId },
    });
    if (!profile) throw notFound();
    return profile;
  }
}

// ======================================================================== status

/**
 * One category's standing on one machine.
 *
 * The record it is read from is the latest check (by when it was performed) among the
 * records nothing has corrected. A corrected record is out entirely — it was wrong. An
 * older check that was simply followed by a newer one is history, not a second
 * standing status.
 *
 * Precedence is the order a person should act in: a failed check matters even if it is
 * not due again for a year, and an overdue one matters even though it passed.
 */
export function categoryStatus(records: readonly ShieldEvidenceRecord[], dueSoonDays: number, now: Date): CategoryStatus {
  const corrected = new Set(records.map((r) => r.supersedesId).filter((x): x is string => x !== null));
  const standing = records
    .filter((r) => !corrected.has(r.id))
    .sort((a, b) => b.performedAt.getTime() - a.performedAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime());
  const latest = standing[0];
  if (!latest) return { status: 'not_recorded', record: null };

  let status: ShieldStatus = 'current';
  if (latest.result !== 'passed') status = 'action_required';
  else if (latest.dueAt && latest.dueAt.getTime() < now.getTime()) status = 'overdue';
  else if (latest.dueAt && latest.dueAt.getTime() <= now.getTime() + dueSoonDays * 86_400_000) status = 'due_soon';
  return { status, record: view(latest, null) };
}

/** The latest `shield_due_soon_days` row per (scope, scope_ref) at `now`, for one tenant. */
async function dueSoonRows(m: EntityManager, tenantId: string, now: Date): Promise<ParameterRow[]> {
  const raw: (Omit<ParameterRow, 'effectiveFrom'> & { effectiveFrom: Date | string })[] = await m.query(
    `SELECT DISTINCT ON ("scope", COALESCE("scope_ref", ''))
            "scope", "scope_ref" AS "scopeRef", "name", "value", "unit", "effective_from" AS "effectiveFrom"
       FROM "tenant_parameter"
      WHERE "tenant_id" = $1 AND "name" = $2 AND "effective_from" <= $3
      ORDER BY "scope", COALESCE("scope_ref", ''), "effective_from" DESC`,
    [tenantId, DUE_SOON_PARAMETER, now],
  );
  return raw.map((r) => ({ ...r, effectiveFrom: new Date(r.effectiveFrom) }));
}

function dueSoonWindow(rows: readonly ParameterRow[], profile: EquipmentProfile): DueSoonWindow {
  const resolved = resolveFromRows(rows, chainForEquipment(profile), [DUE_SOON_PARAMETER]).get(DUE_SOON_PARAMETER);
  if (resolved && typeof resolved.value === 'number') {
    return { days: resolved.value, source: 'parameter', parameter: resolved.source };
  }
  return { days: DEFAULT_DUE_SOON_DAYS, source: 'default', parameter: null };
}

function emptySummary(now: Date): ShieldSummary {
  return { asOf: now.toISOString(), counts: Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ShieldStatus, number>, machines: [] };
}

// ======================================================================== writing

/** What the database cannot judge: a check that has not happened yet. */
function checkInput(input: EvidenceInput, now: Date): void {
  if (input.performedAt.getTime() > now.getTime()) {
    throw new BadRequestException('performedAt is in the future. Record a check once it has been done.');
  }
}

function fields(input: EvidenceInput) {
  return {
    title: input.title.trim(),
    result: input.result,
    performedAt: input.performedAt,
    dueAt: input.dueAt ?? null,
    ownerUserId: input.ownerUserId ?? null,
    ownerName: input.ownerName?.trim() || null,
    reference: input.reference ?? null,
    findings: input.findings ?? null,
  };
}

async function insert(m: EntityManager, row: Omit<ShieldEvidenceRecord, 'id' | 'createdAt'>): Promise<ShieldEvidenceRecord> {
  const repo = m.getRepository(ShieldEvidenceRecord);
  // `insert`, not `save`: save would try an UPDATE for a row it believes exists, and
  // this table has no UPDATE to give.
  const result = await repo.insert(row);
  return repo.findOneByOrFail({ id: result.identifiers[0].id as string });
}

function sameContent(r: ShieldEvidenceRecord, input: EvidenceInput): boolean {
  const f = fields(input);
  const t = (d: Date | null) => d?.getTime() ?? null;
  return r.title === f.title && r.result === f.result && t(r.performedAt) === t(f.performedAt) && t(r.dueAt) === t(f.dueAt)
    && r.ownerUserId === f.ownerUserId && r.ownerName === f.ownerName
    && r.reference === f.reference && r.findings === f.findings;
}

function mapWriteError(error: unknown): never {
  if (error instanceof QueryFailedError) {
    const e = error as QueryFailedError & { code?: string; constraint?: string };
    if (e.code === '23503' && e.constraint === 'fk_shield_evidence_owner') {
      throw new BadRequestException('ownerUserId is not a user of this account.');
    }
    if (e.code === '23514') throw new BadRequestException(`Refused by the database: ${error.message}`);
  }
  throw error;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const e = error as QueryFailedError & { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === constraint;
}

// ======================================================================== views

function withSupersession(rows: readonly ShieldEvidenceRecord[]): EvidenceView[] {
  const correctedBy = new Map(rows.filter((r) => r.supersedesId).map((r) => [r.supersedesId as string, r.id]));
  return rows.map((r) => view(r, correctedBy.get(r.id) ?? null));
}

function view(r: ShieldEvidenceRecord, supersededById: string | null): EvidenceView {
  return {
    id: r.id, category: r.category, title: r.title, result: r.result,
    performedAt: r.performedAt.toISOString(), dueAt: r.dueAt?.toISOString() ?? null,
    ownerUserId: r.ownerUserId, ownerName: r.ownerName, reference: r.reference, findings: r.findings,
    recordedBy: r.recordedBy, recordedAt: r.createdAt.toISOString(),
    supersedesId: r.supersedesId, supersededById,
  };
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
