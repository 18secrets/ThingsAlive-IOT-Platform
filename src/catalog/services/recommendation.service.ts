import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { DeviceProjection } from '../../projection/entities/device-projection.entity';
import { SensorMapProjection } from '../../projection/entities/sensor-map-projection.entity';
import { TelemetryReading } from '../../telemetry/telemetry-reading.entity';
import { withTenantSession } from '../../scope/tenant-session';
import { ScenarioDefinition, ScenarioTier } from '../entities/scenario-definition.entity';
import { CatalogService } from './catalog.service';

export type Bucket = 'availableNow' | 'availableLater' | 'notApplicable';

/**
 * Why a scenario is not available, in a shape the UI can act on.
 *
 * A reason code and its specifics, never a sentence. "Not enough data" on a screen
 * gives an operator nothing to do; `{ code: 'missing-signals', signals:
 * ['coolant_temp'] }` tells them which sensor to fit.
 */
export type Blocker =
  | { code: 'unclassified' }
  | { code: 'class-not-entitled' }
  | { code: 'no-device' }
  | { code: 'missing-signals'; signals: string[] }
  | { code: 'insufficient-history'; haveDays: number; needDays: number }
  | { code: 'tier-too-low'; have: string; needs: ScenarioTier };

export interface Recommendation {
  scenarioSlug: string;
  scenarioVersion: number;
  name: string;
  severity: string;
  tier: ScenarioTier;
  bucket: Bucket;
  blockedBy: Blocker[];
  /** Only when the wait is time, not a missing part. Null whenever it is unknowable. */
  estimatedReadyDate: string | null;
}

/** Which scenario tiers each service tier may run. */
const TIER_CEILING: Record<string, ScenarioTier> = {
  basic: 1, standard: 1, advanced: 2, full: 3,
};

/**
 * Which scenarios an asset can run, and what is stopping the rest (task P1-10).
 *
 * Every answer comes from recorded metadata: the class binding, the sensor map, the
 * declared requirements, the age of the oldest reading. Nothing here infers a
 * capability from the shape of the data, because a recommendation engine that guesses
 * produces a list that is confidently wrong — and the customer's first experience of
 * the product is activating a scenario that then never fires.
 *
 * The three buckets answer different questions. `notApplicable` means nothing about
 * this asset will change the answer: wrong class, or a class the tenant has not been
 * granted. `availableLater` means blocked by something nameable with a path out of
 * it. `availableNow` means every declared requirement is already met.
 */
@Injectable()
export class RecommendationService {
  constructor(
    private readonly ds: DataSource,
    private readonly catalog: CatalogService,
  ) {}

  async forEquipment(
    scope: RequestScope,
    sourceSystem: string,
    externalId: string,
    now = new Date(),
  ): Promise<{ equipmentClassSlug: string | null; recommendations: Recommendation[] }> {
    const facts = await this.gather(scope, sourceSystem, externalId, now);

    // An unclassified asset is the ordinary state on day one, not an error. Every
    // scenario is reported as blocked by one nameable thing — classify it — rather
    // than the asset showing an empty list, which reads as "nothing is available for
    // this machine" and is the wrong conclusion to leave a customer with.
    if (!facts.classSlug) {
      const all = await this.catalog.scenarios(scope);
      return {
        equipmentClassSlug: null,
        recommendations: all.map((s) => base(s, [{ code: 'unclassified' }], 'availableLater')),
      };
    }

    // Classified as something this tenant is not entitled to, or that is no longer
    // published. Nothing about the asset will change that, so its scenarios are
    // notApplicable rather than blocked — and the tenant's own catalog is still
    // listed the same way, so the screen explains itself instead of going blank.
    let candidates: ScenarioDefinition[];
    try {
      candidates = await this.catalog.scenariosForClass(scope, facts.classSlug);
    } catch {
      const all = await this.catalog.scenarios(scope);
      return {
        equipmentClassSlug: facts.classSlug,
        recommendations: all.map((s) => base(s, [{ code: 'class-not-entitled' }], 'notApplicable')),
      };
    }

    return {
      equipmentClassSlug: facts.classSlug,
      recommendations: candidates.map((s) => this.assess(s, facts, now)),
    };
  }

  private assess(scenario: ScenarioDefinition, facts: AssetFacts, now: Date): Recommendation {
    const blockers: Blocker[] = [];

    const noDevice = facts.imeis.length === 0;
    if (noDevice) blockers.push({ code: 'no-device' });

    // With no logger fitted, every signal is missing and naming them is noise: the
    // action is "fit a logger", not "fit eight sensors", and nobody knows yet which
    // signals that logger will carry. A blocker list is only useful while somebody
    // reads it.
    const missing = noDevice ? [] : scenario.requiredSignals.filter((s) => !facts.signals.has(s));
    if (missing.length) blockers.push({ code: 'missing-signals', signals: missing });

    const ceiling = TIER_CEILING[facts.tier] ?? 1;
    if (scenario.tier > ceiling) {
      blockers.push({ code: 'tier-too-low', have: facts.tier, needs: scenario.tier });
    }

    let readyDate: string | null = null;
    if (scenario.minimumHistoryDays > 0) {
      const have = facts.historyDays;
      if (have < scenario.minimumHistoryDays) {
        blockers.push({
          code: 'insufficient-history',
          haveDays: Math.floor(have),
          needDays: scenario.minimumHistoryDays,
        });
        // Only meaningful once readings are arriving. With no history at all there is
        // no start date to count from, and inventing one would put a confident date
        // on a screen that nothing is working towards.
        if (facts.firstReadingAt) {
          const ready = new Date(facts.firstReadingAt);
          ready.setUTCDate(ready.getUTCDate() + scenario.minimumHistoryDays);
          readyDate = ready.toISOString();
        }
      }
    }

    if (!blockers.length) return base(scenario, [], 'availableNow');

    // A date is only offered when time alone will clear the blockage. If a sensor is
    // missing, the date would be a promise nobody is keeping.
    const onlyTime = blockers.every((b) => b.code === 'insufficient-history');
    return {
      ...base(scenario, blockers, 'availableLater'),
      estimatedReadyDate: onlyTime ? readyDate : null,
    };
  }

  /** One pass over the tenant's own rows, inside that tenant's session. */
  private async gather(
    scope: RequestScope,
    sourceSystem: string,
    externalId: string,
    now: Date,
  ): Promise<AssetFacts> {
    const aliases = await this.catalog.aliasMap(sourceSystem);

    return withTenantSession(this.ds, scope, async (m) => {
      const profile = await m.getRepository(EquipmentProfile).findOne({
        where: { sourceSystem, externalId, tenantId: scope.tenantId },
      });

      // Devices first, then the signals those devices report. The sensor map is
      // keyed by IMEI and says nothing about which asset a device is fitted to —
      // that link lives on the device projection, and going through it is what makes
      // "this asset's signals" mean the signals of the devices actually on it.
      const devices = await m.getRepository(DeviceProjection).find({
        where: { tenantId: scope.tenantId, sourceSystem, equipmentExternalId: externalId },
      });
      const imeis = [...new Set(devices.map((d) => d.imei))];

      const sensorRows = imeis.length
        ? await m.getRepository(SensorMapProjection).find({
            where: imeis.map((imei) => ({ imei, tenantId: scope.tenantId })),
          })
        : [];
      const signals = new Set(sensorRows.map((r) => this.catalog.canonicalise(r.signal, aliases)));

      let firstReadingAt: Date | null = null;
      if (imeis.length) {
        const [row] = await m.getRepository(TelemetryReading).find({
          where: imeis.map((imei) => ({ imei, tenantId: scope.tenantId })),
          order: { sourceTimestamp: 'ASC' },
          take: 1,
        });
        firstReadingAt = row?.sourceTimestamp ?? null;
      }

      const historyDays = firstReadingAt
        ? (now.getTime() - firstReadingAt.getTime()) / 86_400_000
        : 0;

      return {
        classSlug: profile?.equipmentClassSlug ?? null,
        tier: profile?.tier ?? 'basic',
        imeis,
        signals,
        firstReadingAt,
        historyDays,
      };
    });
  }
}

interface AssetFacts {
  classSlug: string | null;
  tier: string;
  imeis: string[];
  signals: Set<string>;
  firstReadingAt: Date | null;
  historyDays: number;
}

function base(s: ScenarioDefinition, blockers: Blocker[], bucket: Bucket): Recommendation {
  return {
    scenarioSlug: s.slug,
    scenarioVersion: s.version,
    name: s.name,
    severity: s.severity,
    tier: s.tier,
    bucket,
    blockedBy: blockers,
    estimatedReadyDate: null,
  };
}
