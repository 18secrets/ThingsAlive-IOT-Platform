import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentClassProfile } from '../../catalog/entities/equipment-class-profile.entity';
import { SIGNALS } from '../../common/signals';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { withTenantSession } from '../../scope/tenant-session';
import { TelemetryReading } from '../../telemetry/telemetry-reading.entity';
import { EquipmentServiceRecord, ServiceKind } from '../entities/equipment-service-record.entity';
import { Calibration, RuntimeUnit, calibrateRuntimeUnit } from './runtime-unit';
import {
  Datum, FleetComparison, Forecast, compareToFleet, forecastService, resolveInterval,
} from './service-forecast';

/** How far back the rate and the calibration look. Long enough for both to settle. */
export const RATE_WINDOW_DAYS = 30;

export interface AssetRef {
  sourceSystem: string;
  externalId: string;
}

export interface RecordServiceInput {
  performedAt?: Date;
  kind?: ServiceKind;
  meterReading?: number | null;
  meterUnit?: RuntimeUnit | null;
  workOrderId?: string | null;
  notes?: string | null;
}

export interface AssetForecast extends Forecast {
  sourceSystem: string;
  externalId: string;
  name: string | null;
  equipmentClassSlug: string | null;
  plantId: string | null;
  fleet: FleetComparison;
  lastServiceAt: Date | null;
  meterReadingAt: Date | null;
}

/**
 * The service forecast, assembled from four places (task P4-07).
 *
 * The interval comes from the machine or its class, the meter from telemetry, the
 * datum from the service history, and the rate from the duty-cycle rows P4-05 writes.
 * None of the four is guaranteed to be there, and the shape of this service is mostly
 * about carrying "which one is missing" all the way out to the caller rather than
 * collapsing it into a null.
 *
 * The calibration is fleet-wide and computed once per request rather than per machine.
 * It is a fact about how the loggers are configured, not about any one asset, and
 * deriving it per machine would let a quiet asset with four usable windows get a
 * different unit from its neighbour.
 */
@Injectable()
export class ServiceForecastService {
  private readonly logger = new Logger(ServiceForecastService.name);

  constructor(private readonly ds: DataSource) {}

  /**
   * Write down that a service happened.
   *
   * The meter reading is taken as the fitter read it, in the unit they read it in,
   * and stored unconverted — a calibration corrected next month cannot reach back
   * through a number that was converted on the way in.
   */
  async recordService(
    scope: RequestScope, ref: AssetRef, input: RecordServiceInput,
  ): Promise<EquipmentServiceRecord> {
    const hasReading = input.meterReading !== undefined && input.meterReading !== null;
    const hasUnit = input.meterUnit !== undefined && input.meterUnit !== null;
    if (hasReading !== hasUnit) {
      // The database refuses this too. Refusing it here as well turns a constraint
      // violation into a sentence that says which half is missing.
      throw new BadRequestException(
        'A meter reading needs the unit it was read in, and a unit needs a reading. '
        + 'Send both or neither.',
      );
    }
    const performedAt = input.performedAt ?? new Date();
    if (performedAt.getTime() > Date.now() + 60_000) {
      throw new BadRequestException('A service cannot have been performed in the future.');
    }

    return withTenantSession(this.ds, scope, async (m) => {
      const asset = await m.getRepository(EquipmentProfile).findOne({
        where: { tenantId: scope.tenantId, ...ref },
      });
      // A service against a machine that is not in the register is a typo in an
      // external id, and storing it would make a machine's history silently incomplete
      // while a row sat somewhere nobody reads.
      if (!asset) {
        throw new BadRequestException(
          `No machine ${ref.externalId} in this account's equipment register.`,
        );
      }

      const repo = m.getRepository(EquipmentServiceRecord);
      return repo.save(repo.create({
        tenantId: scope.tenantId,
        sourceSystem: ref.sourceSystem,
        externalId: ref.externalId,
        performedAt,
        kind: input.kind ?? 'scheduled',
        meterReading: input.meterReading ?? null,
        meterUnit: input.meterUnit ?? null,
        workOrderId: input.workOrderId ?? null,
        notes: input.notes ?? null,
        recordedBy: scope.userId ?? null,
      }));
    });
  }

  async history(
    scope: RequestScope, ref: AssetRef, take = 50,
  ): Promise<EquipmentServiceRecord[]> {
    if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(ref.externalId)) {
      return [];
    }
    return withTenantSession(this.ds, scope, (m) =>
      m.getRepository(EquipmentServiceRecord).find({
        where: { tenantId: scope.tenantId, ...ref },
        order: { performedAt: 'DESC' },
        take,
      }));
  }

  /** What the meter is counting in, across this account's fleet. */
  async calibration(scope: RequestScope, now = new Date()): Promise<Calibration> {
    return withTenantSession(this.ds, scope, async (m) => {
      const since = new Date(now.getTime() - RATE_WINDOW_DAYS * 86400_000);
      const rows = await m.query(
        `SELECT "engine_on_seconds", "coverage", "runtime_delta", "runtime_counter_reset",
                "external_id", "local_date"
           FROM "utilization_shift"
          WHERE "tenant_id" = $1 AND "window_start" >= $2 AND "runtime_delta" IS NOT NULL
          LIMIT 5000`,
        [scope.tenantId, since],
      );
      return calibrateRuntimeUnit(rows.map((r: Record<string, unknown>) => ({
        engineOnSeconds: Number(r.engine_on_seconds),
        coverage: Number(r.coverage),
        runtimeDelta: r.runtime_delta === null ? null : Number(r.runtime_delta),
        runtimeCounterReset: r.runtime_counter_reset === true,
        externalId: String(r.external_id),
        localDate: String(r.local_date),
      })));
    });
  }

  /**
   * The forecast for every machine the caller can see.
   *
   * One pass over the fleet rather than a query per machine: the fleet comparison
   * needs every peer's rate anyway, so fetching them one at a time would be both
   * slower and unable to answer the question it exists for.
   */
  async fleetForecast(
    scope: RequestScope, now = new Date(),
  ): Promise<{ calibration: Calibration; assets: AssetForecast[] }> {
    const calibration = await this.calibration(scope, now);

    return withTenantSession(this.ds, scope, async (m) => {
      const since = new Date(now.getTime() - RATE_WINDOW_DAYS * 86400_000);

      const assets = await m.getRepository(EquipmentProfile).find({
        where: { tenantId: scope.tenantId },
      });
      const visible = scope.equipmentIds === undefined
        ? assets
        : assets.filter((a) => scope.equipmentIds!.includes(a.externalId));
      if (!visible.length) return { calibration, assets: [] };

      const classes = new Map<string, number | null>();
      for (const c of await m.getRepository(EquipmentClassProfile).find()) {
        // Latest published version wins; the catalog keeps every version, and an
        // older one's interval is not the current answer.
        const seen = classes.get(c.slug);
        if (seen === undefined || c.serviceIntervalHours !== null) {
          classes.set(c.slug, c.serviceIntervalHours ?? seen ?? null);
        }
      }

      // Engine hours per machine over the rate window, from the duty-cycle rows. Days
      // are counted from the windows actually measured rather than from the calendar:
      // a machine only registered a week ago has a week of history, not thirty days,
      // and dividing its hours by thirty would report it at a third of its real rate.
      const rateRows = await m.query(
        `SELECT "external_id",
                sum("engine_on_seconds") AS engine_on_seconds,
                count(DISTINCT "local_date")::int AS days
           FROM "utilization_shift"
          WHERE "tenant_id" = $1 AND "window_start" >= $2
          GROUP BY "external_id"`,
        [scope.tenantId, since],
      );
      const rates = new Map<string, { engineOnSeconds: number; days: number }>(
        rateRows.map((r: Record<string, unknown>) => [
          String(r.external_id),
          { engineOnSeconds: Number(r.engine_on_seconds ?? 0), days: Number(r.days ?? 0) },
        ]),
      );

      const meters = await this.latestMeterReadings(m, scope.tenantId);
      const data = await this.latestServiceRecords(m, scope.tenantId);

      // Pass one: everything that does not need the fleet.
      const partial = visible.map((asset) => {
        const rate = rates.get(asset.externalId) ?? { engineOnSeconds: 0, days: 0 };
        const meter = meters.get(asset.externalId) ?? null;
        const record = data.get(asset.externalId) ?? null;

        // A replaced meter is not a service, but it is the event that makes every
        // earlier reading incomparable — so it is still the datum, and the hours since
        // it are counted from there.
        const usableRecord = record && record.meterReading !== null ? record : null;
        const datum: Datum | null = usableRecord ? 'service-record'
          : asset.commissionedAt ? 'commissioning' : null;

        // Commissioning has no meter reading beside it, so the honest assumption is a
        // meter that started at zero. Stated rather than silent: a machine whose logger
        // was fitted years into its life will read high, and the forecast will say it
        // is overdue — which is visibly wrong and fixed by recording one service.
        const meterAtDatum = usableRecord ? usableRecord.meterReading
          : datum === 'commissioning' ? 0 : null;

        const forecast = forecastService({
          interval: resolveInterval({
            equipmentHours: asset.serviceIntervalHours,
            classHours: asset.equipmentClassSlug ? classes.get(asset.equipmentClassSlug) ?? null : null,
            classSlug: asset.equipmentClassSlug,
          }),
          meterReading: meter?.value ?? null,
          meterUnit: calibration.unit,
          meterAtDatum,
          datum,
          datumAt: usableRecord?.performedAt ?? asset.commissionedAt ?? null,
          engineOnSeconds: rate.engineOnSeconds,
          rateDays: rate.days,
          now,
        });

        return {
          asset, forecast,
          lastServiceAt: record?.performedAt ?? null,
          meterReadingAt: meter?.at ?? null,
        };
      });

      // Pass two: the comparison, which needs every peer of the same class. Built from
      // the whole fleet rather than from the visible slice — an operator seeing two
      // machines should still be told how theirs compares to the other thirty.
      const byClass = new Map<string, { hoursPerDay: number | null }[]>();
      for (const asset of assets) {
        const slug = asset.equipmentClassSlug;
        if (!slug) continue;
        const rate = rates.get(asset.externalId);
        const hoursPerDay = rate && rate.days >= 7
          ? Math.round((rate.engineOnSeconds / 3600 / rate.days) * 100) / 100
          : null;
        byClass.set(slug, [...(byClass.get(slug) ?? []), { hoursPerDay }]);
      }

      const out: AssetForecast[] = partial.map(({ asset, forecast, lastServiceAt, meterReadingAt }) => ({
        ...forecast,
        sourceSystem: asset.sourceSystem,
        externalId: asset.externalId,
        name: asset.name,
        equipmentClassSlug: asset.equipmentClassSlug,
        plantId: asset.plantId,
        lastServiceAt,
        meterReadingAt,
        fleet: compareToFleet(
          forecast,
          asset.equipmentClassSlug
            ? (byClass.get(asset.equipmentClassSlug) ?? []).filter((p) => p !== undefined)
            : [],
        ),
      }));

      // Overdue first, then due, then by hours remaining. The order the list is
      // actually read in; alphabetical by asset code would bury the urgent ones.
      const RANK: Record<string, number> = { overdue: 0, due: 1, approaching: 2, ok: 3 };
      out.sort((a, b) => {
        const ra = RANK[a.status ?? ''] ?? 4;
        const rb = RANK[b.status ?? ''] ?? 4;
        if (ra !== rb) return ra - rb;
        return (a.hoursRemaining ?? Infinity) - (b.hoursRemaining ?? Infinity);
      });

      return { calibration, assets: out };
    });
  }

  /** The newest hour-meter reading per machine, via the sensor map. */
  private async latestMeterReadings(
    m: { query: (sql: string, p: unknown[]) => Promise<Record<string, unknown>[]> },
    tenantId: string,
  ): Promise<Map<string, { value: number; at: Date }>> {
    const rows = await m.query(
      // Machine to device to reading. This joined `sensor_map_projection.external_id`
      // as though it were the equipment code; it is the upstream *measurement* id, so
      // the join matched nothing in real data. The fixture that tested it encoded the
      // same mistake, which is why it passed. The device projection is the table that
      // knows which loggers are fitted to which machine.
      `SELECT DISTINCT ON (d."equipment_external_id")
              d."equipment_external_id" AS external_id, r."value", r."source_timestamp"
         FROM "telemetry_reading" r
         JOIN "device_projection" d
           ON d."imei" = r."imei" AND d."tenant_id" = r."tenant_id"
        WHERE r."tenant_id" = $1 AND r."signal" = $2
          AND d."equipment_external_id" IS NOT NULL
        ORDER BY d."equipment_external_id", r."source_timestamp" DESC`,
      [tenantId, SIGNALS.engineRuntime],
    );
    return new Map(rows.map((r) => [
      String(r.external_id),
      { value: Number(r.value), at: new Date(r.source_timestamp as string) },
    ]));
  }

  /** The newest service record per machine that carries a meter reading. */
  private async latestServiceRecords(
    m: { query: (sql: string, p: unknown[]) => Promise<Record<string, unknown>[]> },
    tenantId: string,
  ): Promise<Map<string, { performedAt: Date; meterReading: number | null }>> {
    const rows = await m.query(
      `SELECT DISTINCT ON ("external_id") "external_id", "performed_at", "meter_reading"
         FROM "equipment_service_record"
        WHERE "tenant_id" = $1
        ORDER BY "external_id", "performed_at" DESC`,
      [tenantId],
    );
    return new Map(rows.map((r) => [
      String(r.external_id),
      {
        performedAt: new Date(r.performed_at as string),
        meterReading: r.meter_reading === null ? null : Number(r.meter_reading),
      },
    ]));
  }
}
