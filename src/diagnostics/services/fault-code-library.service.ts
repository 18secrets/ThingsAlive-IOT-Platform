import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { runTenantSpanning, withTenantId } from '../../scope/tenant-session';
import { FAULT_CODE_TYPES, FaultCodeType, FaultCodeTypeGrant } from '../entities/fault-code-type-grant.entity';
import { CodeRow, CodeWorkbookRefusal, buildCodeTemplate, parseCodeWorkbook } from './fault-code-workbook';

/** One code, the same shape whichever table it came from; a field the kind lacks is null. */
export interface FaultCodeItem {
  id: string;
  code: string;
  description: string;
  symptom: string | null;
  causes: string | null;
  remedies: string | null;
  detection: string | null;
  foundBy: 'logger' | 'technician' | null;
  severity: string;
  lamp: string;
  spn: number | null;
  fmi: number | null;
  /** Where it came from: 1.0's copy (before 17 Nov 2026), or 2.0. Both are edited here. */
  source: '1.0' | '2.0';
  /** A vehicle code's: the unit that raises it, and the maker's own code. Null for motor codes. */
  system: string | null;
  oemCode: string | null;
  /** A vehicle code's, from the engine makers' sheets (VehicleCodesOwned1765600000000). Null for motor codes. */
  sensor: string | null;
  location: string | null;
  pinDetails: string | null;
  voltageRange: string | null;
  signalRange: string | null;
  diagnosticAids: string | null;
  troubleshooting: string | null;
  vehicleReaction: string | null;
  retiredAt: string | null;
}

export interface FaultCodePage { type: FaultCodeType; total: number; codes: FaultCodeItem[] }

export interface CodeQuery { q?: string; limit?: number; offset?: number; includeRetired?: boolean; id?: string }

/** The fields Master Admin writes. A code's own key (P101, SPN:177:FMI:16) is fixed once
 * it exists: fault history points at it by that key. */
export interface CodeInput {
  code?: string; spn?: number | null; fmi?: number | null;
  description?: string; symptom?: string | null; causes?: string | null; remedies?: string | null;
  detection?: string | null; foundBy?: 'logger' | 'technician' | null; severity?: string; lamp?: string;
  system?: string | null; oemCode?: string | null; sensor?: string | null; location?: string | null;
  pinDetails?: string | null; voltageRange?: string | null; signalRange?: string | null;
  diagnosticAids?: string | null; troubleshooting?: string | null; vehicleReaction?: string | null;
}

export interface FaultCodeRevision {
  id: string; library: 'vehicle' | 'motor'; codeId: string; code: string; field: string;
  oldValue: string | null; newValue: string | null; changedBy: string;
  /** The person's name (or email) when they are platform staff; null otherwise. */
  changedByName: string | null; changedAt: string;
}

/** What each library lets Master Admin change, by API field and its column. */
const EDITABLE: Record<'vehicle' | 'motor', Record<string, string>> = {
  vehicle: {
    description: 'description', causes: 'causes', remedies: 'remedies', severity: 'severity', lamp: 'lamp',
    system: 'source_unit', oemCode: 'oem_code', sensor: 'sensor', location: 'location', pinDetails: 'pin_details',
    voltageRange: 'voltage_range', signalRange: 'signal_range', diagnosticAids: 'diagnostic_aids',
    troubleshooting: 'troubleshooting', vehicleReaction: 'vehicle_reaction',
  },
  motor: {
    description: 'description', symptom: 'symptom', causes: 'causes', remedies: 'remedies', detection: 'detection',
    foundBy: 'found_by', severity: 'severity', lamp: 'lamp',
  },
};
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const LAMPS = ['red_stop', 'amber_warning', 'protect', 'mil', 'none'];

/** Vehicle kinds and the protocol their rows carry in `dtc_master_catalog`. */
const VEHICLE_PROTOCOL: Partial<Record<FaultCodeType, 'j1939' | 'obd2'>> = { 'vehicle-j1939': 'j1939', 'vehicle-obd2': 'obd2' };

export const MAX_PAGE = 500;

export function isFaultCodeType(value: string): value is FaultCodeType {
  return (FAULT_CODE_TYPES as readonly string[]).includes(value);
}

/**
 * The fault code library (step 1): which kinds of code each account is given, and the
 * codes of a kind. Vehicle codes are read from `dtc_master_catalog`, motor codes from
 * `fault_code_motor`; both are 2.0's own since 1.0 stopped being the vehicle source.
 *
 * Grants are written in the tenant-spanning session — the only one the table's row
 * security lets write — and read back in the account's own session, where the same
 * policy shows an account its own rows and nobody else's.
 */
@Injectable()
export class FaultCodeLibraryService {
  private readonly logger = new Logger(FaultCodeLibraryService.name);

  constructor(private readonly ds: DataSource) {}

  /** Every grant, every account: Master Admin's view. */
  listGrants(): Promise<FaultCodeTypeGrant[]> {
    return runTenantSpanning(this.ds, 'fault code grants: list', (m) =>
      m.getRepository(FaultCodeTypeGrant).find({ order: { tenantId: 'ASC', codeType: 'ASC' } }));
  }

  /**
   * Gives an account a kind of code. Idempotent: granting what the account already has
   * changes nothing and returns the grant it has; granting a revoked kind brings that row
   * back. One statement settles a race — two grants fired together leave one row, and the
   * second finds it.
   */
  async grant(scope: RequestScope, tenantId: string, codeType: string, note?: string): Promise<FaultCodeTypeGrant> {
    if (!isFaultCodeType(codeType)) {
      throw new BadRequestException(`"${codeType}" is not a kind of fault code. Use one of: ${FAULT_CODE_TYPES.join(', ')}.`);
    }
    return runTenantSpanning(this.ds, `fault code grant: ${codeType} to ${tenantId}`, async (m) => {
      const [tenant] = await m.query(`SELECT 1 FROM "tenant" WHERE "tenant_id" = $1`, [tenantId]);
      // A grant to an account that does not exist is a typo that would look like a
      // working grant until somebody wondered why nothing showed.
      if (!tenant) throw new BadRequestException(`No account "${tenantId}" to grant to.`);
      const [restored] = await m.query(
        `INSERT INTO "fault_code_type_grant" ("tenant_id", "code_type", "granted_by", "note")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("tenant_id", "code_type") DO UPDATE
           SET "revoked_at" = NULL, "revoked_by" = NULL, "granted_by" = EXCLUDED."granted_by", "granted_at" = now(),
               "note" = COALESCE(EXCLUDED."note", "fault_code_type_grant"."note")
           WHERE "fault_code_type_grant"."revoked_at" IS NOT NULL
         RETURNING "id"`,
        [tenantId, codeType, scope.userId, note ?? null],
      );
      if (restored) this.logger.log(`Granted ${codeType} to ${tenantId} by ${scope.userId}.`);
      // Already granted (and so untouched above), or just written: the row as it stands.
      return m.getRepository(FaultCodeTypeGrant).findOneOrFail({ where: { tenantId, codeType } });
    });
  }

  /** Withdraws a grant. The row stays; revoked is not deleted. */
  async revoke(scope: RequestScope, id: string): Promise<FaultCodeTypeGrant> {
    return runTenantSpanning(this.ds, `fault code grant: revoke ${id}`, async (m) => {
      const [row] = (await m.query(
        `UPDATE "fault_code_type_grant" SET "revoked_at" = now(), "revoked_by" = $2
          WHERE "id" = $1 AND "revoked_at" IS NULL RETURNING "id"`, [id, scope.userId],
      ))[0] ?? [];
      if (!row) throw new NotFoundException('No active fault code grant with that id.');
      this.logger.warn(`Revoked fault code grant ${id} by ${scope.userId}.`);
      return m.getRepository(FaultCodeTypeGrant).findOneOrFail({ where: { id } });
    });
  }

  /** The kinds this account has, with how many codes each holds. */
  async myTypes(scope: RequestScope): Promise<{ type: FaultCodeType; total: number }[]> {
    return withTenantId(this.ds, scope.tenantId, async (m) => {
      const types = await this.grantedTypes(m, scope.tenantId);
      return Promise.all(types.map(async (type) => ({ type, total: (await this.page(m, type, { limit: 0 })).total })));
    });
  }

  /**
   * The codes of one kind, for an account given it. A kind it was not given is "not
   * found", as an ungranted equipment class is: a refusal would say the kind exists.
   */
  async myCodes(scope: RequestScope, type: string, query: CodeQuery): Promise<FaultCodePage> {
    return withTenantId(this.ds, scope.tenantId, async (m) => {
      if (!isFaultCodeType(type) || !(await this.grantedTypes(m, scope.tenantId)).includes(type)) {
        throw new NotFoundException(`No fault codes "${type}" in this account.`);
      }
      // Retired codes are history, not the library an account works from.
      return this.page(m, type, { ...query, includeRetired: false });
    });
  }

  /** The codes of one kind, for Master Admin: every code, retired ones on request. */
  async codes(type: string, query: CodeQuery): Promise<FaultCodePage> {
    if (!isFaultCodeType(type)) throw new NotFoundException(`No kind of fault code "${type}".`);
    return runTenantSpanning(this.ds, `fault codes: ${type}`, (m) => this.page(m, type, query));
  }

  // ------------------------------------------------------------------ editing (step 2)

  /**
   * Adds a code. One already in the library under the same key is refused, whichever
   * system it came from: one key, one meaning, and fault history points at it.
   */
  async create(scope: RequestScope, type: string, input: CodeInput): Promise<FaultCodeItem> {
    const fields = this.validate(libraryOf(type), input, true);
    return runTenantSpanning(this.ds, `fault code: add ${type}`, (m) => this.createIn(m, scope, type, input, fields));
  }

  /** `create` inside the caller's transaction: one code, or one row of an import. */
  private async createIn(
    m: EntityManager, scope: RequestScope, type: string, input: CodeInput, fields: Record<string, string | null>,
  ): Promise<FaultCodeItem> {
    const library = libraryOf(type);
    {
      let id: string;
      try {
        if (library === 'motor') {
          const code = motorKey(input.code);
          [{ id }] = await m.query(
            `INSERT INTO "fault_code_motor" ("code", "description", "symptom", "causes", "remedies", "detection", "found_by",
               "severity", "lamp", "updated_by")
             VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 'medium'), coalesce($9, 'none'), $10) RETURNING "id"`,
            [code, fields.description, fields.symptom ?? null, fields.causes ?? null, fields.remedies ?? null,
              fields.detection ?? null, fields.found_by ?? null, fields.severity ?? null, fields.lamp ?? null, scope.userId],
          );
        } else {
          const { protocol, code, spn, fmi } = vehicleKey(type, input);
          // The text columns are whichever the input filled; the column names come from
          // EDITABLE, never from the input.
          const text = Object.entries(fields).filter(([column]) => !['description', 'severity', 'lamp'].includes(column));
          [{ id }] = await m.query(
            `INSERT INTO "dtc_master_catalog" ("protocol", "code", "spn", "fmi", "description", "severity", "lamp", "source_system"
               ${text.map(([column]) => `, "${column}"`).join('')})
             VALUES ($1, $2, $3, $4, $5, coalesce($6, 'medium'), coalesce($7, 'none'), '2.0'
               ${text.map((_, i) => `, $${i + 8}`).join('')}) RETURNING "id"`,
            [protocol, code, spn, fmi, fields.description, fields.severity ?? null, fields.lamp ?? null, ...text.map(([, v]) => v)],
          );
        }
      } catch (err) {
        throw friendly(err, type);
      }
      const item = await this.item(m, type, id);
      await this.record(m, library, item, scope.userId, [['created', null, item.description]]);
      return item;
    }
  }

  /**
   * Changes a code's text, field by field. The row is locked first, so two edits at once
   * apply in turn: the second compares against the first's result, and an edit that
   * changes nothing writes nothing — no update, no history row.
   */
  async update(scope: RequestScope, type: string, id: string, input: CodeInput): Promise<FaultCodeItem> {
    const fields = this.validate(libraryOf(type), input, false);
    return runTenantSpanning(this.ds, `fault code: edit ${type} ${id}`, (m) => this.updateIn(m, scope, type, id, fields));
  }

  /** `update` inside the caller's transaction: one edit, or one row of an import. */
  private async updateIn(
    m: EntityManager, scope: RequestScope, type: string, id: string, fields: Record<string, string | null>,
  ): Promise<FaultCodeItem> {
    const library = libraryOf(type);
    {
      const table = library === 'motor' ? 'fault_code_motor' : 'dtc_master_catalog';
      const [current] = await m.query(`SELECT * FROM "${table}" WHERE "id" = $1 FOR UPDATE`, [id]);
      if (!current || (library === 'vehicle' && current.protocol !== VEHICLE_PROTOCOL[type as FaultCodeType])) {
        throw new NotFoundException(`No ${type} code with that id.`);
      }
      const changes: [string, string | null, string | null][] = [];
      const sets: string[] = [];
      const values: unknown[] = [id];
      for (const [column, value] of Object.entries(fields)) {
        const before = current[column] ?? null;
        if ((before ?? null) === (value ?? null)) continue;
        values.push(value);
        sets.push(`"${column}" = $${values.length}`);
        changes.push([column, before, value as string | null]);
      }
      if (sets.length) {
        // Motor codes say who last changed them; the history says it for both.
        if (library === 'motor') {
          values.push(scope.userId);
          sets.push(`"updated_by" = $${values.length}`);
        }
        await m.query(`UPDATE "${table}" SET ${sets.join(', ')}, "updated_at" = now() WHERE "id" = $1`, values);
      }
      const item = await this.item(m, type, id);
      await this.record(m, library, item, scope.userId, changes);
      return item;
    }
  }

  /** Retires a code (or brings it back). Never a delete: fault history points at it. */
  async setRetired(scope: RequestScope, type: string, id: string, retired: boolean): Promise<FaultCodeItem> {
    const library = libraryOf(type);
    return runTenantSpanning(this.ds, `fault code: ${retired ? 'retire' : 'restore'} ${type} ${id}`, async (m) => {
      const table = library === 'motor' ? 'fault_code_motor' : 'dtc_master_catalog';
      const [current] = await m.query(`SELECT * FROM "${table}" WHERE "id" = $1 FOR UPDATE`, [id]);
      if (!current || (library === 'vehicle' && current.protocol !== VEHICLE_PROTOCOL[type as FaultCodeType])) {
        throw new NotFoundException(`No ${type} code with that id.`);
      }
      if ((current.retired_at !== null) !== retired) {
        await m.query(`UPDATE "${table}" SET "retired_at" = ${retired ? 'now()' : 'NULL'} WHERE "id" = $1`, [id]);
        const item = await this.item(m, type, id);
        await this.record(m, library, item, scope.userId, [['retired', retired ? 'no' : 'yes', retired ? 'yes' : 'no']]);
        return item;
      }
      return this.item(m, type, id);
    });
  }

  // ------------------------------------------------------------------ bulk import (step 3)

  /** The template for one kind: its columns, a read-me, and one example row. */
  async template(type: string): Promise<Buffer> {
    libraryOf(type); // refuses a kind that does not exist
    return buildCodeTemplate(type as FaultCodeType);
  }

  /**
   * Checks a workbook row by row and, with `apply`, writes it: new codes added, changed
   * ones edited, each with its history, in one transaction. Applying is refused whole
   * while any row is in error — half a file is a library nobody asked for.
   *
   * Idempotent: the same file applied twice changes nothing the second time. Two applies
   * at once take turns on a per-kind lock and each plans against what the other wrote,
   * so a code is never added twice.
   */
  async importCodes(scope: RequestScope, type: string, buffer: Buffer, apply: boolean): Promise<FaultCodeImport> {
    const library = libraryOf(type);
    const kind = type as FaultCodeType;
    let rows: CodeRow[];
    try {
      rows = await parseCodeWorkbook(kind, buffer);
    } catch (err) {
      if (err instanceof CodeWorkbookRefusal) throw new BadRequestException(err.message);
      throw err;
    }
    return runTenantSpanning(this.ds, `fault codes: ${apply ? 'apply' : 'check'} import ${type}`, async (m) => {
      if (apply) await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`fault-code-import:${type}`]);
      const table = library === 'motor' ? 'fault_code_motor' : 'dtc_master_catalog';
      const existing: Record<string, unknown>[] = library === 'motor'
        ? await m.query(`SELECT * FROM "fault_code_motor"`)
        : await m.query(`SELECT * FROM "dtc_master_catalog" WHERE "protocol" = $1`, [VEHICLE_PROTOCOL[kind]]);
      const byCode = new Map(existing.map((e) => [String(e.code), e]));
      const seen = new Map<string, number>();
      const planned: (FaultCodeImportRow & { input?: CodeInput; fields?: Record<string, string | null>; id?: string })[] = [];

      for (const { row, values } of rows) {
        const input = rowInput(values);
        let code = '';
        try {
          code = library === 'motor' ? motorKey(input.code) : vehicleKey(type, input).code;
          if (seen.has(code)) throw new BadRequestException(`The same code as row ${seen.get(code)}.`);
          seen.set(code, row);
          const current = byCode.get(code);
          const fields = this.validate(library, input, !current);
          if (!current) {
            planned.push({ row, code, status: 'new', input, fields });
            continue;
          }
          const changes = Object.entries(fields)
            .filter(([column, value]) => ((current[column] as string | null) ?? null) !== (value ?? null))
            .map(([field, to]) => ({ field, from: (current[field] as string | null) ?? null, to }));
          planned.push(changes.length
            ? { row, code, status: 'changed', changes, fields, id: String(current.id) }
            : { row, code, status: 'unchanged' });
        } catch (err) {
          if (!(err instanceof BadRequestException)) throw err;
          planned.push({ row, code: code || String(values.code ?? ''), status: 'error', error: err.message });
        }
      }

      const summary = { new: 0, changed: 0, unchanged: 0, errors: 0 };
      for (const p of planned) summary[p.status === 'error' ? 'errors' : p.status] += 1;
      const result = (applied: boolean): FaultCodeImport => ({
        type: kind, applied, summary,
        rows: planned.map(({ row, code, status, changes, error }) => ({ row, code, status, ...(changes ? { changes } : {}), ...(error ? { error } : {}) })),
      });
      if (!apply || summary.errors > 0 || (summary.new === 0 && summary.changed === 0)) return result(false);

      for (const p of planned) {
        if (p.status === 'new') await this.createIn(m, scope, type, p.input!, p.fields!);
        else if (p.status === 'changed') await this.updateIn(m, scope, type, p.id!, p.fields!);
      }
      this.logger.log(`Imported ${type}: ${summary.new} new, ${summary.changed} changed, by ${scope.userId} (${table}).`);
      return result(true);
    });
  }

  /** A code's edits, newest first. */
  async history(type: string, id: string): Promise<FaultCodeRevision[]> {
    const library = libraryOf(type);
    return runTenantSpanning(this.ds, `fault code: history ${type} ${id}`, async (m) => {
      await this.item(m, type, id);
      return m.query(
        // Who, by name: the history showed a bare user id. The id stays the record; the
        // name is read at the time of asking, so a renamed person reads as they are now.
        `SELECT r."id", r."library", r."code_id" AS "codeId", r."code", r."field", r."old_value" AS "oldValue",
                r."new_value" AS "newValue", r."changed_by" AS "changedBy",
                coalesce(nullif(btrim(u."full_name"), ''), u."email") AS "changedByName", r."changed_at" AS "changedAt"
           FROM "fault_code_revision" r
           LEFT JOIN "platform_user" u ON u."id"::text = r."changed_by"
          WHERE r."library" = $1 AND r."code_id" = $2 ORDER BY r."changed_at" DESC, r."id"`,
        [library, id],
      );
    });
  }

  private async item(m: EntityManager, type: string, id: string): Promise<FaultCodeItem> {
    if (!isFaultCodeType(type)) throw new NotFoundException(`No kind of fault code "${type}".`);
    const [found] = (await this.page(m, type, { id, includeRetired: true, limit: 1 })).codes;
    if (!found) throw new NotFoundException(`No ${type} code with that id.`);
    return found;
  }

  private async record(
    m: EntityManager, library: 'vehicle' | 'motor', item: FaultCodeItem, by: string, changes: [string, string | null, string | null][],
  ): Promise<void> {
    for (const [field, before, after] of changes) {
      await m.query(
        `INSERT INTO "fault_code_revision" ("library", "code_id", "code", "field", "old_value", "new_value", "changed_by")
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [library, item.id, item.code, field, before, after, by],
      );
    }
  }

  /** The editable fields present in `input`, by column, each checked; blank text is null. */
  private validate(library: 'vehicle' | 'motor', input: CodeInput, creating: boolean): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const [field, column] of Object.entries(EDITABLE[library])) {
      const raw = (input as Record<string, unknown>)[field];
      if (raw === undefined) continue;
      if (raw !== null && typeof raw !== 'string') throw new BadRequestException(`${field} must be text.`);
      const text = (raw as string | null)?.trim() ?? '';
      out[column] = text === '' ? null : text;
    }
    if ((creating || 'description' in out) && !out.description) throw new BadRequestException('A code needs a fault title (description).');
    if ('severity' in out && (!out.severity || !SEVERITIES.includes(out.severity))) {
      throw new BadRequestException(`severity must be one of: ${SEVERITIES.join(', ')}.`);
    }
    if ('lamp' in out && (!out.lamp || !LAMPS.includes(out.lamp))) throw new BadRequestException(`lamp must be one of: ${LAMPS.join(', ')}.`);
    if (out.found_by != null && !['logger', 'technician'].includes(out.found_by)) {
      throw new BadRequestException('foundBy must be logger or technician.');
    }
    return out;
  }

  private async grantedTypes(m: EntityManager, tenantId: string): Promise<FaultCodeType[]> {
    const rows: { code_type: FaultCodeType }[] = await m.query(
      `SELECT "code_type" FROM "fault_code_type_grant" WHERE "tenant_id" = $1 AND "revoked_at" IS NULL ORDER BY "code_type"`,
      [tenantId],
    );
    return rows.map((r) => r.code_type);
  }

  private async page(m: EntityManager, type: FaultCodeType, query: CodeQuery): Promise<FaultCodePage> {
    const limit = Math.max(0, Math.min(Number.isFinite(query.limit) ? query.limit! : 100, MAX_PAGE));
    const offset = Math.max(0, Number.isFinite(query.offset) ? query.offset! : 0);
    const search = query.q?.trim() ? `%${query.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const protocol = VEHICLE_PROTOCOL[type];
    // One shape from either table.
    const source = protocol
      ? `SELECT "id", "code", "description", NULL::text AS "symptom", "causes", "remedies", NULL::text AS "detection",
                NULL::text AS "foundBy", "severity", "lamp", "spn", "fmi", "source_system" AS "source",
                "source_unit" AS "system", "oem_code" AS "oemCode", "sensor", "location", "pin_details" AS "pinDetails",
                "voltage_range" AS "voltageRange", "signal_range" AS "signalRange", "diagnostic_aids" AS "diagnosticAids",
                "troubleshooting", "vehicle_reaction" AS "vehicleReaction", "retired_at" AS "retiredAt"
           FROM "dtc_master_catalog" WHERE "protocol" = $1`
      : `SELECT "id", "code", "description", "symptom", "causes", "remedies", "detection",
                "found_by" AS "foundBy", "severity", "lamp", NULL::int AS "spn", NULL::int AS "fmi", '2.0'::text AS "source",
                NULL::text AS "system", NULL::text AS "oemCode", NULL::text AS "sensor", NULL::text AS "location",
                NULL::text AS "pinDetails", NULL::text AS "voltageRange", NULL::text AS "signalRange",
                NULL::text AS "diagnosticAids", NULL::text AS "troubleshooting", NULL::text AS "vehicleReaction",
                "retired_at" AS "retiredAt"
           FROM "fault_code_motor" WHERE $1::text IS NULL`; // $1, the protocol, is a vehicle kind's only
    const filter = `WHERE ($2::text IS NULL OR c."code" ILIKE $2 OR c."description" ILIKE $2)
                      AND ($3::boolean OR c."retiredAt" IS NULL) AND ($6::uuid IS NULL OR c."id" = $6)`;
    const params = [protocol ?? null, search, query.includeRetired === true];
    const id = query.id ?? null;
    // $4 and $5 are the page's; the count names them too, so both statements number alike.
    const [{ total }] = await m.query(
      `SELECT count(*)::int AS "total" FROM (${source}) c ${filter} AND $4::int IS NOT NULL AND $5::int IS NOT NULL`,
      [...params, limit, offset, id],
    );
    const rows = limit === 0 ? [] : await m.query(
      `SELECT * FROM (${source}) c ${filter} ORDER BY c."code" LIMIT $4 OFFSET $5`, [...params, limit, offset, id],
    );
    return {
      type, total,
      codes: rows.map((r: Record<string, unknown>) => ({
        ...r,
        spn: r.spn == null ? null : Number(r.spn),
        fmi: r.fmi == null ? null : Number(r.fmi),
        retiredAt: r.retiredAt ? new Date(r.retiredAt as string).toISOString() : null,
      })) as FaultCodeItem[],
    };
  }
}

export interface FaultCodeImportRow {
  row: number;
  code: string;
  status: 'new' | 'changed' | 'unchanged' | 'error';
  /** For a changed code: each field it changes, from what to what. */
  changes?: { field: string; from: string | null; to: string | null }[];
  error?: string;
}

export interface FaultCodeImport {
  type: FaultCodeType;
  /** False for a check, and for an apply refused because a row is in error. */
  applied: boolean;
  summary: { new: number; changed: number; unchanged: number; errors: number };
  rows: FaultCodeImportRow[];
}

/** The words the sheet uses for stored values, and back. */
const LABEL = {
  severity: { critical: 'Critical', high: 'Warning', medium: 'Medium', low: 'Low', info: 'Info' } as Record<string, string>,
  lamp: { red_stop: 'Red stop', amber_warning: 'Amber warning', protect: 'Protect', mil: 'Check engine', none: 'No lamp' } as Record<string, string>,
  foundBy: { logger: 'Logger', technician: 'Technician' } as Record<string, string>,
};
const fromLabel = (map: Record<string, string>, text: string) => {
  const t = text.trim().toLowerCase();
  return Object.entries(map).find(([key, label]) => key === t || label.toLowerCase() === t)?.[0] ?? text.trim();
};

/** A sheet row as an edit: only the filled cells, the sheet's words turned back into stored values. */
function rowInput(values: Record<string, string>): CodeInput {
  const input: Record<string, unknown> = {};
  for (const [field, raw] of Object.entries(values)) {
    if (raw === '') continue;
    if (field === 'spn' || field === 'fmi') input[field] = Number(raw);
    else if (field === 'severity') input[field] = fromLabel(LABEL.severity, raw);
    else if (field === 'lamp') input[field] = fromLabel(LABEL.lamp, raw);
    else if (field === 'foundBy') input[field] = fromLabel(LABEL.foundBy, raw);
    else input[field] = raw;
  }
  return input as CodeInput;
}

function motorKey(raw: string | undefined): string {
  const code = (raw ?? '').trim().toUpperCase();
  if (!/^P[0-9]{3}$/.test(code)) throw new BadRequestException('A motor code is P and three digits, e.g. P103.');
  return code;
}

function libraryOf(type: string): 'vehicle' | 'motor' {
  if (!isFaultCodeType(type)) throw new NotFoundException(`No kind of fault code "${type}".`);
  return type === 'motor-pump' ? 'motor' : 'vehicle';
}

/** A vehicle code's key, keyed as the packet decoder keys what a machine sends. */
function vehicleKey(type: string, input: CodeInput): { protocol: 'j1939' | 'obd2'; code: string; spn: number | null; fmi: number | null } {
  if (type === 'vehicle-j1939') {
    const spn = Number(input.spn);
    const fmi = Number(input.fmi);
    if (!Number.isInteger(spn) || spn < 0 || !Number.isInteger(fmi) || fmi < 0 || fmi > 31) {
      throw new BadRequestException('A J1939 code needs a whole-number SPN and an FMI from 0 to 31.');
    }
    return { protocol: 'j1939', code: `SPN:${spn}:FMI:${fmi}`, spn, fmi };
  }
  // With the ECU's fault type (P0425-85) or without (P0119): the makers' sheets use both,
  // and the same base code with two fault types is two faults, so the suffix is the key.
  const code = (input.code ?? '').trim().toUpperCase();
  if (!/^[PCBU][0-9A-F]{4}(-[0-9A-F]{2})?$/.test(code)) {
    throw new BadRequestException('An OBD-II code is a letter (P, C, B or U) and four characters, with or without a fault type: P0101 or P0425-85.');
  }
  return { protocol: 'obd2', code, spn: null, fmi: null };
}

/** A refusal the database gave, said in the reader's terms. */
function friendly(err: unknown, type: string): Error {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (err instanceof BadRequestException) return err;
  if (e.code === '23505') {
    return new ConflictException(type === 'motor-pump'
      ? 'That motor code is already in the library.'
      : 'That vehicle code is already in the library.');
  }
  if (e.code === '23514') return new BadRequestException(e.message ?? 'The database refused that code.');
  return err as Error;
}
