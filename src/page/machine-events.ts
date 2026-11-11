import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { Reading } from '../catalog/formula/baseline-operators';
import { TelemetryWindowReader } from '../kpi/services/telemetry-window-reader';
import { chainForEquipment, resolveParameters } from '../parameters/services/parameter-resolution';
import { bindingSegments, overlapping } from '../signal-binding/services/signal-binding.service';

/**
 * A pump's event history (Crompton U6, 11 Nov 2026): starts, trips with their reason, and
 * the supply leaving the model's warning band, as one dated list. Each is already a signal
 * (the motor job writes starts and inferred trips per minute; the logger sends the minute's
 * lowest and highest voltage), and the machine page showed them only as today's counts.
 *
 * Read, never stored: the readings are the record. A voltage event is judged against the
 * model's own warning lines (D57), so a machine without them has none, not a guessed band,
 * and the answer says so.
 */
export type MachineEventKind = 'start' | 'trip_overload' | 'trip_supply' | 'trip_overtemp' | 'voltage_low' | 'voltage_high';

export interface MachineEvent {
  at: string;
  kind: MachineEventKind;
  /** Starts or trips in the minute; the voltage reached for a voltage event. */
  value: number;
  /** The line it crossed, for a voltage event (V). */
  limit?: number;
}

export interface MachineEvents {
  from: string;
  to: string;
  events: MachineEvent[];
  /** Kinds the window could not judge, and why: the signal is not bound, or the band is unknown. */
  unavailable: { kind: 'starts' | 'trips' | 'voltage'; reason: 'unbound' | 'no_voltage_band' }[];
  /** True when the window held more events than are returned (newest kept). */
  truncated: boolean;
}

/** A week is the longest window: a service visit looks back days, not months. */
export const MAX_EVENT_WINDOW_DAYS = 7;
const MAX_EVENTS = 500;
const COUNT_SIGNALS: Record<string, MachineEventKind> = {
  motor_starts: 'start', trip_overload: 'trip_overload', trip_supply: 'trip_supply', trip_overtemp: 'trip_overtemp',
};
const VOLTAGE_SIGNALS = ['supply_voltage_min', 'supply_voltage_max'];

export function eventWindow(from: Date | undefined, to: Date | undefined, now: Date): { from: Date; to: Date } {
  const end = to && to < now ? to : now;
  const start = from ?? new Date(end.getTime() - 86_400_000);
  if (start >= end) throw new BadRequestException('from must be before to.');
  if (end.getTime() - start.getTime() > MAX_EVENT_WINDOW_DAYS * 86_400_000) {
    throw new BadRequestException(`An event window is at most ${MAX_EVENT_WINDOW_DAYS} days.`);
  }
  return { from: start, to: end };
}

export async function readMachineEvents(
  m: EntityManager, reader: TelemetryWindowReader, tenantId: string, profile: EquipmentProfile,
  window: { from: Date; to: Date },
): Promise<MachineEvents> {
  const ref = { sourceSystem: profile.sourceSystem, externalId: profile.externalId };
  const signals = [...Object.keys(COUNT_SIGNALS), ...VOLTAGE_SIGNALS];
  const segments = overlapping(
    await bindingSegments(m, tenantId, ref, signals, { by: 'signalKey', componentId: '' }), window.from, window.to,
  );
  const bound = new Set(segments.map((s) => s.signal));
  const readings = segments.length
    ? await reader.readSegments(m, tenantId, segments.map(({ signal, imei, from, to }) => ({ signal, imei, from, to })), window.from, window.to)
    : new Map<string, Reading[]>();

  const events: MachineEvent[] = [];
  for (const [signal, kind] of Object.entries(COUNT_SIGNALS)) {
    for (const r of readings.get(signal) ?? []) {
      if (r.value > 0) events.push({ at: r.at.toISOString(), kind, value: r.value });
    }
  }

  const unavailable: MachineEvents['unavailable'] = [];
  if (!bound.has('motor_starts')) unavailable.push({ kind: 'starts', reason: 'unbound' });
  if (!['trip_overload', 'trip_supply', 'trip_overtemp'].some((s) => bound.has(s))) unavailable.push({ kind: 'trips', reason: 'unbound' });

  if (!VOLTAGE_SIGNALS.some((s) => bound.has(s))) {
    unavailable.push({ kind: 'voltage', reason: 'unbound' });
  } else {
    const band = await resolveParameters(m, tenantId, chainForEquipment(profile), ['voltage_warn_low', 'voltage_warn_high'], window.to);
    const low = numberOf(band.get('voltage_warn_low')?.value);
    const high = numberOf(band.get('voltage_warn_high')?.value);
    if (low === null && high === null) unavailable.push({ kind: 'voltage', reason: 'no_voltage_band' });
    if (low !== null) {
      for (const r of readings.get('supply_voltage_min') ?? []) {
        if (r.value < low) events.push({ at: r.at.toISOString(), kind: 'voltage_low', value: r.value, limit: low });
      }
    }
    if (high !== null) {
      for (const r of readings.get('supply_voltage_max') ?? []) {
        if (r.value > high) events.push({ at: r.at.toISOString(), kind: 'voltage_high', value: r.value, limit: high });
      }
    }
  }

  // Newest first, as a log is read; a trip before a start in the same minute.
  const order: MachineEventKind[] = ['trip_overload', 'trip_overtemp', 'trip_supply', 'voltage_low', 'voltage_high', 'start'];
  events.sort((a, b) => b.at.localeCompare(a.at) || order.indexOf(a.kind) - order.indexOf(b.kind));
  return {
    from: window.from.toISOString(), to: window.to.toISOString(),
    events: events.slice(0, MAX_EVENTS), unavailable, truncated: events.length > MAX_EVENTS,
  };
}

function numberOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
