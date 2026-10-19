import { EntityManager } from 'typeorm';
import { EquipmentClassSensorRequirement } from '../catalog/entities/equipment-class-sensor-requirement.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { TelemetryWindowReader } from '../kpi/services/telemetry-window-reader';
import { tenantStaleAfterSeconds } from '../parameters/services/parameter-resolution';
import { bindingSegments, BindingSegment, EquipmentRef } from '../signal-binding/services/signal-binding.service';
import { classifyFreshness, resolveStaleAfterSeconds } from '../signal-binding/services/signal-freshness';

/**
 * Which signals this machine's class version declares a forecast for (D40 §3) — the one
 * definition, called by the pass and by the machine page. Two definitions of "declared"
 * would be the device_projection / device_inventory defect again: a forecast the page
 * calls undeclared, or a declared one the pass never makes.
 *
 * One row per measurement role: a role declared on several components is one signal
 * here, with the longest horizon any of them asks for.
 */
export async function forecastDeclarations(
  m: EntityManager, classSlug: string | null, classVersion: number | null,
): Promise<EquipmentClassSensorRequirement[]> {
  if (!classSlug || !classVersion) return [];
  const rows = await m.getRepository(EquipmentClassSensorRequirement).find({
    where: { classSlug, classVersion, forecastEnabled: true },
  });
  const byRole = new Map<string, EquipmentClassSensorRequirement>();
  for (const r of rows) {
    const held = byRole.get(r.measurementRole);
    if (!held || (r.forecastHorizonHours ?? 0) > (held.forecastHorizonHours ?? 0)) byRole.set(r.measurementRole, r);
  }
  return [...byRole.values()];
}

export type InputState = 'ready' | 'stale' | 'no_readings' | 'unbound';

export interface SignalInput {
  state: InputState;
  lastReadingAt: Date | null;
  segments: BindingSegment[];
}

/**
 * Whether each declared signal is fit to forecast from (Q08S s3), the way coverage
 * decides it: the binding's device over the binding's window (by measurement role), the
 * newest reading inside it, and the stale threshold with the tenant's parameter first,
 * then the requirement's, then the platform default. A dead sensor is not forecast — a
 * forecast from it is a confident fiction (D40).
 */
export async function signalInputs(
  m: EntityManager, tenantId: string, profile: EquipmentProfile,
  requirements: EquipmentClassSensorRequirement[], at: Date,
): Promise<Map<string, SignalInput>> {
  const ref: EquipmentRef = { sourceSystem: profile.sourceSystem, externalId: profile.externalId };
  const roles = requirements.map((r) => r.measurementRole);
  const segments = await bindingSegments(m, tenantId, ref, roles, { by: 'measurementRole' });
  const latest = await new TelemetryWindowReader().latestPerSignalInSegments(
    m, tenantId, segments.map(({ signal, imei, from, to }) => ({ signal, imei, from, to })), at,
  );
  const tenantStale = await tenantStaleAfterSeconds(m, tenantId, profile, at);
  const out = new Map<string, SignalInput>();
  for (const r of requirements) {
    const own = segments.filter((s) => s.signal === r.measurementRole);
    if (!own.length) {
      out.set(r.measurementRole, { state: 'unbound', lastReadingAt: null, segments: [] });
      continue;
    }
    const last = latest.get(r.measurementRole) ?? null;
    const state = classifyFreshness(last, at, resolveStaleAfterSeconds(r, tenantStale));
    out.set(r.measurementRole, { state, lastReadingAt: last, segments: own });
  }
  return out;
}
