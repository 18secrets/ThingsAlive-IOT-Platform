import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { EquipmentRef } from '../kpi/types';
import { withTenantSession } from '../scope/tenant-session';
import { SignalBindingVersion } from '../signal-binding/entities/signal-binding-version.entity';
import { MAX_BACKFILL_MONTHS } from '../telemetry/telemetry.service';
import {
  FUTURE_SKEW_MS, MAX_LISTED_REFUSALS, parseInstant, parseValue, readRows, RefusalReason, RowRefusal, sameUnit,
} from './readings-csv';

/**
 * Uploaded history is `replayed`: a deliberate load of the past, not what a logger sent.
 * The label carries into every baseline (`mixed` when it meets live readings) and every
 * prediction built only from it, so a result computed from an upload can always be told
 * from one computed from the machines (G10).
 */
export const IMPORT_SOURCE = 'replayed' as const;

const INSERT_CHUNK = 5_000;

export interface SensorSummary { sensor: string; signal: string; imei: string; unit: string; rows: number; from: string; to: string }

export interface ImportReport {
  equipment: EquipmentRef;
  source: typeof IMPORT_SOURCE;
  rows: number;
  valid: number;
  /** Plan: valid rows already stored (same device, signal and time), which apply would skip. */
  alreadyStored?: number;
  /** Apply only. */
  inserted?: number;
  duplicates?: number;
  refused: { count: number; byReason: Partial<Record<RefusalReason, number>>; rows: RowRefusal[] };
  sensors: SensorSummary[];
}

interface Valid { line: number; sensor: string; imei: string; signal: string; unit: string; at: Date; value: number }

/**
 * Historical readings for one machine from a CSV (timestamp, sensor, value, unit).
 *
 * Each row is stored under the binding that was primary and active for its sensor at its
 * timestamp — the device and signal the readers already look under — so a forecast, a
 * baseline or a KPI reads an uploaded hour exactly as it reads a live one. A row no
 * binding covers is refused rather than stored: the readers bound history below by the
 * earliest binding, so it would be kept and never read.
 *
 * Plan and apply take the same file and the same checks; there is no stored batch. Apply
 * writes nothing unless every row is valid, and is idempotent: the dedupe index decides
 * what is new, so a file loaded twice, or twice at once, stores each reading once.
 */
@Injectable()
export class ReadingsImportService {
  constructor(private readonly ds: DataSource) {}

  async plan(scope: RequestScope, ref: EquipmentRef, csv: string, now = new Date()): Promise<ImportReport> {
    return withTenantSession(this.ds, scope, async (m) => {
      const { report, valid } = await this.check(m, scope, ref, csv, now);
      return { ...report, alreadyStored: await this.countStored(m, scope.tenantId, valid) };
    });
  }

  async apply(scope: RequestScope, ref: EquipmentRef, csv: string, now = new Date()): Promise<ImportReport> {
    const { report, valid } = await withTenantSession(this.ds, scope, (m) => this.check(m, scope, ref, csv, now));
    if (report.refused.count) {
      const reasons = Object.entries(report.refused.byReason).map(([r, n]) => `${r}: ${n}`).join(', ');
      throw new UnprocessableEntityException({
        code: 'rows_refused',
        message: `${report.refused.count} of ${report.rows} rows refused (${reasons}); nothing was stored. `
          + 'Run the plan for each refused line and its reason.',
      });
    }
    // History lands in months nobody built, so each is built first. The function runs as
    // its owner (PartitionAsOwner1762200000000), is safe under concurrent callers and
    // writes no tenant data; the rows themselves go in under RLS below.
    for (const month of new Set(valid.map((v) => `${v.at.toISOString().slice(0, 7)}-01`))) {
      await this.ds.query(`SELECT ensure_telemetry_partition($1::date)`, [month]);
    }
    const inserted = await withTenantSession(this.ds, scope, async (m) => {
      let n = 0;
      for (let i = 0; i < valid.length; i += INSERT_CHUNK) {
        const chunk = valid.slice(i, i + INSERT_CHUNK);
        const rows: unknown[] = await m.query(
          `INSERT INTO "telemetry_reading" ("tenant_id", "imei", "signal", "value", "unit", "source_timestamp", "received_at", "source")
             SELECT $1, imei, signal, value, unit, ts, $2, $3
               FROM unnest($4::text[], $5::text[], $6::double precision[], $7::text[], $8::timestamptz[])
                    AS r(imei, signal, value, unit, ts)
           ON CONFLICT DO NOTHING
           RETURNING 1`,
          [scope.tenantId, now, IMPORT_SOURCE, chunk.map((v) => v.imei), chunk.map((v) => v.signal),
            chunk.map((v) => v.value), chunk.map((v) => v.unit), chunk.map((v) => v.at.toISOString())],
        );
        n += rows.length;
      }
      return n;
    });
    return { ...report, inserted, duplicates: valid.length - inserted };
  }

  /** The machine's sensors as an empty CSV to fill in: one line per bound sensor, with its unit. */
  async template(scope: RequestScope, ref: EquipmentRef): Promise<string> {
    return withTenantSession(this.ds, scope, async (m) => {
      await this.profile(m, scope, ref);
      const signals = [...new Map((await this.bindings(m, scope.tenantId, ref)).map((b) => [b.signalKey, b.canonicalUnit])).entries()]
        .sort(([a], [b]) => a.localeCompare(b));
      return ['timestamp,sensor,value,unit', ...signals.map(([s, u]) => `,${s},,${u}`)].join('\n') + '\n';
    });
  }

  // ---------------------------------------------------------------------- checks

  private async check(m: EntityManager, scope: RequestScope, ref: EquipmentRef, csv: string, now: Date) {
    await this.profile(m, scope, ref);
    const rows = readRows(csv);
    const bindings = await this.bindings(m, scope.tenantId, ref);
    const byName = new Map<string, SignalBindingVersion[]>();
    for (const b of bindings) {
      for (const name of new Set([b.signalKey, b.measurementRole])) byName.set(name, [...(byName.get(name) ?? []), b]);
    }
    const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MAX_BACKFILL_MONTHS, 1));

    const refusals: RowRefusal[] = [];
    const valid: Valid[] = [];
    const seen = new Map<string, number>();
    const refuse = (line: number, reason: RefusalReason, detail: string) => refusals.push({ line, reason, detail });

    for (const r of rows) {
      if (!r.timestamp || !r.sensor || !r.value) {
        refuse(r.line, 'missing_field', 'timestamp, sensor and value are all required');
        continue;
      }
      const t = parseInstant(r.timestamp);
      if ('reason' in t) {
        refuse(r.line, t.reason, t.reason === 'timestamp_without_zone'
          ? `"${r.timestamp}" has no time zone; write it as 2026-09-01T10:00:00+05:30 or ...Z`
          : `"${r.timestamp}" is not an ISO 8601 date and time`);
        continue;
      }
      if (t.at.getTime() > now.getTime() + FUTURE_SKEW_MS) { refuse(r.line, 'in_the_future', t.at.toISOString()); continue; }
      if (t.at < oldest) {
        refuse(r.line, 'older_than_backfill_limit', `before ${oldest.toISOString().slice(0, 10)} (${MAX_BACKFILL_MONTHS} months)`);
        continue;
      }
      const value = parseValue(r.value);
      if (value === null) { refuse(r.line, 'not_a_number', `"${r.value}"`); continue; }
      const candidates = byName.get(r.sensor);
      if (!candidates) {
        refuse(r.line, 'unknown_sensor', `"${r.sensor}" is not bound to this machine; bound: ${[...new Set(bindings.map((b) => b.signalKey))].sort().join(', ') || 'none'}`);
        continue;
      }
      const binding = candidates.find((b) => b.validFrom <= t.at && (b.validTo === null || t.at < b.validTo));
      if (!binding) {
        const from = candidates.map((b) => b.validFrom.getTime()).sort((a, b) => a - b)[0];
        refuse(r.line, 'no_binding_at_time', `"${r.sensor}" was not bound to this machine at ${t.at.toISOString()} `
          + `(bound from ${new Date(from).toISOString()}); readings outside a binding are never read`);
        continue;
      }
      if (r.unit && !sameUnit(r.unit, binding.canonicalUnit)) {
        refuse(r.line, 'unit_mismatch', `"${r.unit}" given, "${binding.canonicalUnit}" expected; convert before uploading`);
        continue;
      }
      const key = `${binding.imei}|${binding.signalKey}|${t.at.getTime()}`;
      if (seen.has(key)) { refuse(r.line, 'duplicate_in_file', `same sensor and time as line ${seen.get(key)}`); continue; }
      seen.set(key, r.line);
      valid.push({ line: r.line, sensor: r.sensor, imei: binding.imei!, signal: binding.signalKey, unit: binding.canonicalUnit, at: t.at, value });
    }

    const byReason: Partial<Record<RefusalReason, number>> = {};
    for (const x of refusals) byReason[x.reason] = (byReason[x.reason] ?? 0) + 1;
    const report: ImportReport = {
      equipment: { sourceSystem: ref.sourceSystem, externalId: ref.externalId },
      source: IMPORT_SOURCE,
      rows: rows.length,
      valid: valid.length,
      refused: { count: refusals.length, byReason, rows: refusals.slice(0, MAX_LISTED_REFUSALS) },
      sensors: summarise(valid),
    };
    return { report, valid };
  }

  /** Valid rows already in the table, by the dedupe key, so the plan says what apply would add. */
  private async countStored(m: EntityManager, tenantId: string, valid: Valid[]): Promise<number> {
    let n = 0;
    for (let i = 0; i < valid.length; i += INSERT_CHUNK) {
      const chunk = valid.slice(i, i + INSERT_CHUNK);
      const [row] = await m.query(
        `SELECT count(*)::int AS n
           FROM unnest($2::text[], $3::text[], $4::timestamptz[]) AS k(imei, signal, ts)
          WHERE EXISTS (SELECT 1 FROM "telemetry_reading" r
                         WHERE r."tenant_id" = $1 AND r."imei" = k.imei AND r."signal" = k.signal AND r."source_timestamp" = k.ts)`,
        [tenantId, chunk.map((v) => v.imei), chunk.map((v) => v.signal), chunk.map((v) => v.at.toISOString())],
      );
      n += row.n;
    }
    return n;
  }

  /** The bindings the readers use: primary, active, with a device. */
  private async bindings(m: EntityManager, tenantId: string, ref: EquipmentRef): Promise<SignalBindingVersion[]> {
    return (await m.getRepository(SignalBindingVersion).find({
      where: { tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId, isPrimary: true, status: 'active' },
    })).filter((b) => !!b.imei);
  }

  /** Out of scope answers exactly like absent: the same 404 any equipment route gives. */
  private async profile(m: EntityManager, scope: RequestScope, ref: EquipmentRef): Promise<EquipmentProfile> {
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      throw new NotFoundException('No such equipment in this account.');
    }
    const profile = await m.getRepository(EquipmentProfile).findOne({
      where: { tenantId: scope.tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId },
    });
    if (!profile) throw new NotFoundException('No such equipment in this account.');
    return profile;
  }
}

function summarise(valid: Valid[]): SensorSummary[] {
  const by = new Map<string, SensorSummary & { min: number; max: number }>();
  for (const v of valid) {
    const k = `${v.signal}|${v.imei}`;
    const s = by.get(k) ?? { sensor: v.sensor, signal: v.signal, imei: v.imei, unit: v.unit, rows: 0, from: '', to: '', min: Infinity, max: -Infinity };
    s.rows += 1;
    s.min = Math.min(s.min, v.at.getTime());
    s.max = Math.max(s.max, v.at.getTime());
    by.set(k, s);
  }
  return [...by.values()].sort((a, b) => a.signal.localeCompare(b.signal) || a.imei.localeCompare(b.imei))
    .map(({ min, max, ...s }) => ({ ...s, from: new Date(min).toISOString(), to: new Date(max).toISOString() }));
}
