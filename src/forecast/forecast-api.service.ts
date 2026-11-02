import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RequestScope } from '../auth/types/request-scope';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { EquipmentRef } from '../kpi/types';
import { withTenantSession } from '../scope/tenant-session';
import { forecastDeclarations } from './forecast-inputs';
import { ForecastChartData, ForecastReader } from './forecast-reader';

/**
 * One signal's forecast, in the page widget's own shape (readiness, reason, data), so a
 * caller that has read the `forecast_chart` widget reads this without a second parser.
 */
export interface SignalForecast {
  signal: string;
  readiness: 'ready' | 'not_configured' | 'not_available' | 'blocked';
  reason: string | null;
  data: ForecastChartData | null;
}

export interface MachineForecasts {
  equipment: EquipmentRef;
  asOf: string;
  forecasts: SignalForecast[];
}

/**
 * TTM forecasts outside the page (QML1's reader, unchanged). The page shows a forecast
 * only where its layout places a `forecast_chart`; this answers for every signal the
 * class declares, layout or not.
 *
 * It reads; it never invokes the model. A forecast the pass has not written is the
 * reader's `not_available`, never a forecast made on request — that would put a second
 * writer beside the pass and its lock (D40).
 */
@Injectable()
export class ForecastApiService {
  constructor(private readonly ds: DataSource, private readonly reader: ForecastReader) {}

  /** Every declared signal, in name order so two reads of unchanged data are identical. */
  async machine(scope: RequestScope, ref: EquipmentRef, at: Date = new Date()): Promise<MachineForecasts> {
    return withTenantSession(this.ds, scope, async (m) => {
      const profile = await this.profile(m, scope, ref);
      const signals = (await forecastDeclarations(m, profile.equipmentClassSlug, profile.classVersion))
        .map((r) => r.measurementRole).sort();
      const forecasts: SignalForecast[] = [];
      // One at a time: the reader shares this transaction's connection.
      for (const signal of signals) forecasts.push(await this.read(m, scope, profile, signal, at));
      return { equipment: { sourceSystem: ref.sourceSystem, externalId: ref.externalId }, asOf: at.toISOString(), forecasts };
    });
  }

  /**
   * One signal. A signal the class does not declare answers `not_configured`, not 404: the
   * machine exists and the caller may see it, and "nobody asked for this forecast" is the
   * configuration fact the page widget reports for the same case.
   */
  async signal(scope: RequestScope, ref: EquipmentRef, signal: string, at: Date = new Date()): Promise<SignalForecast> {
    return withTenantSession(this.ds, scope, async (m) => this.read(m, scope, await this.profile(m, scope, ref), signal, at));
  }

  private async read(m: EntityManager, scope: RequestScope, profile: EquipmentProfile, signal: string, at: Date): Promise<SignalForecast> {
    const answer = await this.reader.chart(m, scope.tenantId, profile, signal, at);
    return answer.readiness === 'ready'
      ? { signal, readiness: 'ready', reason: null, data: answer.data }
      : { signal, readiness: answer.readiness, reason: answer.reason, data: null };
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
