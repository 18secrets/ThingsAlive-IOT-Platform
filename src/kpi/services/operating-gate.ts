import { EntityManager } from 'typeorm';
import { WindowReading } from '../../alert/services/alert-rules';
import { OperatingGate } from '../../catalog/formula/baseline-operators';
import { EquipmentShift } from '../../shift/entities/equipment-shift.entity';
import { bindingSegments, overlapping } from '../../signal-binding/services/signal-binding.service';
import { AVAILABILITY_SIGNALS, operatingIntervals } from '../../utilization/services/availability';
import { EquipmentRef } from '../types';
import { TelemetryWindowReader } from './telemetry-window-reader';

/**
 * The machine's operating periods across a window (task QFIX-BASELINE) — Availability's
 * own definition, `operatingIntervals`, over the same shift schedule and engine-state
 * signals. The engine-state readings come through the bindings like every other signal
 * (task QFIX-DEVICES), not through `device_projection`. Shifts are applied across the
 * whole window as they stand today, as Availability applies them to a period.
 *
 * A function rather than a method so every baseline uses the one gate: the KPI
 * evaluator, the forecast band (QML1 Q12) and the Tier 1 baseline and scorer, whose
 * services are built without the evaluator.
 */
export async function loadOperatingGate(
  m: EntityManager, tenantId: string, equipment: EquipmentRef, from: Date, to: Date,
  reader: TelemetryWindowReader = new TelemetryWindowReader(),
): Promise<OperatingGate> {
  const shifts = await m.getRepository(EquipmentShift).find({
    where: { tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId, status: 'active' },
  });
  if (!shifts.length) return { scheduled: false, periods: [] };

  const segments = await bindingSegments(
    m, tenantId, equipment, [...AVAILABILITY_SIGNALS], { by: 'signalKey', componentId: '' },
  );
  const bySignal = await reader.readSegments(
    m, tenantId,
    overlapping(segments, from, to).map(({ signal, imei, from: f, to: t }) => ({ signal, imei, from: f, to: t })),
    from, to,
  );
  const readings: WindowReading[] = [];
  for (const [signal, rows] of bySignal) {
    for (const r of rows) readings.push({ signal, value: r.value, sourceTimestamp: r.at.toISOString() });
  }
  // A millisecond past `to`: the KPI window includes its end instant and the interval
  // arithmetic is half-open, so a reading taken exactly at evaluation time — the one a
  // z-score judges — would otherwise always fall just outside every operating period.
  const periods = operatingIntervals(shifts, readings, { from, to: new Date(to.getTime() + 1) })
    .map((i) => ({ start: new Date(i.start), end: new Date(i.end) }));
  return { scheduled: true, periods, observed: readings.length > 0 };
}

/** Whether the gate can separate running from parked at all: a schedule, and engine state read in it. */
export const canGate = (gate: OperatingGate): boolean => gate.scheduled && gate.observed !== false;

/** Whether an instant falls inside an operating period; null when the gate cannot tell. */
export function operatingAt(gate: OperatingGate, at: Date): boolean | null {
  if (!canGate(gate)) return null;
  const t = at.getTime();
  return gate.periods.some((p) => t >= p.start.getTime() && t < p.end.getTime());
}
