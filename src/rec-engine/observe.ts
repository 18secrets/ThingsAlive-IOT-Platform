import { EntityManager, In } from 'typeorm';
import { EquipmentClassSensorRequirement } from '../catalog/entities/equipment-class-sensor-requirement.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { TelemetryWindowReader } from '../kpi/services/telemetry-window-reader';
import { tenantStaleAfterSeconds } from '../parameters/services/parameter-resolution';
import { bindingSegments } from '../signal-binding/services/signal-binding.service';
import { classifyFreshness, resolveStaleAfterSeconds } from '../signal-binding/services/signal-freshness';

export interface SignalObservation {
  signal: string;
  /** A primary, active binding puts a device on this signal at `at`. */
  bound: boolean;
  freshness: 'ready' | 'stale' | 'no_readings';
  lastReadingAt: string | null;
  staleAfterSeconds: number;
}

const reader = new TelemetryWindowReader();

/**
 * Can each of these signals be seen on this machine at `at` (task QREC1 §2)?
 *
 * Built from the same pieces the KPI evaluator and coverage read — the binding
 * segments that put a device on the signal, the latest reading inside them, the
 * tenant's `stale_after_seconds` before the class's own threshold, and
 * `classifyFreshness` — so a signal cannot be fresh on the KPI tile and stale here.
 * Coverage itself only answers for the class's *required* signals; a failure mode may
 * name any declared signal, which is why this asks per signal rather than reusing it.
 *
 * Runs in the caller's transaction, so it reads under whatever tenant session the
 * caller already holds.
 */
export async function observeSignals(
  m: EntityManager, tenantId: string, profile: EquipmentProfile, signals: readonly string[], at: Date,
): Promise<Map<string, SignalObservation>> {
  const out = new Map<string, SignalObservation>();
  const wanted = [...new Set(signals)];
  if (!wanted.length) return out;
  const ref = { sourceSystem: profile.sourceSystem, externalId: profile.externalId };

  const segments = (await bindingSegments(m, tenantId, ref, wanted, { by: 'signalKey', componentId: '' }))
    .filter((s) => s.from <= at);
  const latest = await reader.latestPerSignalInSegments(
    m, tenantId, segments.map(({ signal, imei, from, to }) => ({ signal, imei, from, to })), at,
  );
  const tenantStaleAfter = await tenantStaleAfterSeconds(m, tenantId, profile, at);
  const requirements = profile.equipmentClassSlug && profile.classVersion
    ? await m.getRepository(EquipmentClassSensorRequirement).find({
      where: {
        classSlug: profile.equipmentClassSlug, classVersion: profile.classVersion, componentScope: '',
        measurementRole: In(wanted),
      },
    })
    : [];
  const requirementBySignal = new Map(requirements.map((r) => [r.measurementRole, r]));

  for (const signal of wanted) {
    const bound = segments.some((s) => s.signal === signal && (s.to === null || s.to > at));
    const last = latest.get(signal) ?? null;
    const staleAfterSeconds = resolveStaleAfterSeconds(requirementBySignal.get(signal) ?? null, tenantStaleAfter);
    out.set(signal, {
      signal, bound, freshness: classifyFreshness(last, at, staleAfterSeconds),
      lastReadingAt: last ? last.toISOString() : null, staleAfterSeconds,
    });
  }
  return out;
}

/** Unbound, or bound with nothing recent: the machine cannot show us this signal. */
export function isUnobserved(o: SignalObservation | undefined): boolean {
  return !o || !o.bound || o.freshness !== 'ready';
}
