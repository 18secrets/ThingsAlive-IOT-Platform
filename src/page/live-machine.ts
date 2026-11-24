import { EntityManager } from 'typeorm';
import { LegacyTelemetryReader } from '../legacy/legacy-telemetry.reader';
import { mappedImeisFor } from '../onboarding/mapped-devices';

/**
 * One machine as it is now (the Live view, 13 Nov 2026): each signal's newest value, how
 * old it is, whether the machine is reporting, running, and where it is.
 *
 * "Machine live" showed history: KPIs over a window and a 24 h chart, loaded once. Its
 * values were the scheduled pull's copies, minutes behind, and the Online/Offline shown
 * elsewhere is the last finished shift's link verdict. This reads the newest value of
 * each signal at the moment it is asked: from 1.0 directly for devices that report there
 * (`LegacyTelemetryReader.latestReadings`), and from 2.0's own readings for devices that
 * report to 2.0 (the motor loggers). The newer of the two wins, signal by signal.
 *
 * Connection is the newest reading's age, not a verdict: reporting within five minutes is
 * online, within thirty delayed, older offline. Thresholds a backend owner may tune per
 * device type; they are the right order for loggers that report about once a minute.
 * A motor logger that uploads in five-minute bursts is judged on its uploads instead
 * (LOGGER_OFFLINE_SECONDS).
 */
export const ONLINE_SECONDS = 5 * 60;
export const DELAYED_SECONDS = 30 * 60;
/**
 * A batch-uploading motor logger (Motor Monitor integration spec, 24 Nov 2026) is judged
 * on its uploads, not its readings. It holds five minutes of readings and sends them in
 * one burst, and the motor job places them a pass later, so its newest reading is
 * routinely more than five minutes old on a logger working perfectly: the thresholds
 * above showed every one of them "delayed" between uploads. The spec's rule is the
 * device's own: no successful POST for about ten minutes, two missed bursts, is offline.
 * There is no "delayed" in between; one missed burst is still inside the window.
 */
export const LOGGER_OFFLINE_SECONDS = 10 * 60;
/** A signal not heard from in this long is shown greyed: stale, not current. */
export const SIGNAL_STALE_SECONDS = 15 * 60;
/** How far back a newest value is looked for. */
export const LIVE_LOOKBACK_MS = 24 * 3_600_000;

/** Signals whose value says whether the machine is running, most specific first. */
const RUNNING_SIGNALS = ['engine_running', 'motor_running', 'running_status', 'ignition_status', 'ignition'];
const POSITION_SIGNALS = new Set(['latitude', 'longitude']);

export type LiveConnection = 'online' | 'delayed' | 'offline' | 'no-device';

export interface LiveSignal {
  signal: string;
  value: number | string;
  unit: string | null;
  at: string;
  ageSeconds: number;
  stale: boolean;
  source: '1.0' | '2.0';
}

export interface MachineLive {
  asOf: string;
  connection: LiveConnection;
  lastReadingAt: string | null;
  /** The newest upload the receiver stored from a motor logger on this machine; null without one. */
  lastUploadAt: string | null;
  /** From the machine's own running or ignition signal; null when it has none. */
  running: boolean | null;
  location: { lat: number; lng: number; at: string; ageSeconds: number } | null;
  signals: LiveSignal[];
  /** Whether 1.0 was asked: false when no legacy connection is configured. */
  legacyAsked: boolean;
}

interface Reading { imei: string; signal: string; unit: string | null; value: number | string; at: Date; source: '1.0' | '2.0' }

export async function readMachineLive(
  m: EntityManager,
  legacy: LegacyTelemetryReader | undefined,
  tenantId: string,
  ref: { sourceSystem: string; externalId: string },
  now: Date,
): Promise<MachineLive> {
  const since = new Date(now.getTime() - LIVE_LOOKBACK_MS);
  // The machine's mapped devices, as every status reader asks (mapped-devices.ts). None
  // is "no-device": not onboarded, so no connection state and no values.
  const imeis = await mappedImeisFor(m, tenantId, ref.externalId, now);
  const base = { asOf: now.toISOString(), legacyAsked: !!legacy?.connected };
  if (imeis.length === 0) {
    return { ...base, connection: 'no-device', lastReadingAt: null, lastUploadAt: null, running: null, location: null, signals: [] };
  }

  const local: Reading[] = (await m.query(
    `SELECT DISTINCT ON (imei, signal) imei, signal, unit, value, source_timestamp AS at
       FROM "telemetry_reading"
      WHERE tenant_id = $1 AND imei = ANY($2::text[]) AND source_timestamp > $3
      ORDER BY imei, signal, source_timestamp DESC`,
    [tenantId, imeis, since],
  )).map((r: { imei: string; signal: string; unit: string | null; value: string; at: Date }) => ({
    imei: r.imei, signal: r.signal, unit: r.unit, value: Number(r.value), at: new Date(r.at), source: '2.0' as const,
  }));
  const fromLegacy: Reading[] = legacy?.connected
    ? (await legacy.latestReadings({ tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId }, since))
      // 1.0's sensor map can still list a logger since moved off this machine in 2.0; its
      // values are that logger's, not this machine's.
      .filter((r) => imeis.includes(r.imei))
      .map((r) => ({ ...r, source: '1.0' as const }))
    : [];

  // Newest wins per signal, across devices and sources.
  const newest = new Map<string, Reading>();
  for (const r of [...local, ...fromLegacy]) {
    const held = newest.get(r.signal);
    if (!held || r.at > held.at) newest.set(r.signal, r);
  }
  const age = (at: Date) => Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));

  const all = [...newest.values()];
  const last = all.reduce<Date | null>((a, r) => (!a || r.at > a ? r.at : a), null);
  // Only the receiver writes motor_upload_log, so a row there is what makes a device a
  // batch-uploading logger. Asked by the machine's own mapped devices, never by tenant:
  // the table has no tenant, and these names are already this account's.
  const uploads: { deviceId: string; at: Date }[] = await m.query(
    `SELECT "device_id" AS "deviceId", max("received_at") AS "at" FROM "motor_upload_log"
      WHERE "device_id" = ANY($1::text[]) GROUP BY 1`, [imeis]);
  const loggers = new Set(uploads.map((u) => u.deviceId));
  const lastUpload = uploads.reduce<Date | null>((a, u) => (!a || new Date(u.at) > a ? new Date(u.at) : a), null);
  // A logger's own readings say nothing here: they are always older than its upload.
  const lastOther = [...local, ...fromLegacy].filter((r) => !loggers.has(r.imei))
    .reduce<Date | null>((a, r) => (!a || r.at > a ? r.at : a), null);
  const byReadings: LiveConnection | null = lastOther === null ? null
    : age(lastOther) <= ONLINE_SECONDS ? 'online' : age(lastOther) <= DELAYED_SECONDS ? 'delayed' : 'offline';
  const byUploads: LiveConnection | null = lastUpload === null ? null
    : age(lastUpload) <= LOGGER_OFFLINE_SECONDS ? 'online' : 'offline';
  // A machine with a logger and another device is as connected as the better of the two.
  const rank: Record<LiveConnection, number> = { 'no-device': 0, offline: 1, delayed: 2, online: 3 };
  const connection: LiveConnection = [byReadings, byUploads]
    .reduce<LiveConnection>((best, c) => (c && rank[c] > rank[best] ? c : best), 'offline');

  const runningSignal = RUNNING_SIGNALS.map((s) => newest.get(s)).find(Boolean);
  const running = runningSignal && typeof runningSignal.value === 'number' ? runningSignal.value > 0 : null;

  const lat = newest.get('latitude');
  const lng = newest.get('longitude');
  const location = lat && lng && typeof lat.value === 'number' && typeof lng.value === 'number'
    ? { lat: lat.value, lng: lng.value, at: (lat.at > lng.at ? lat.at : lng.at).toISOString(), ageSeconds: age(lat.at > lng.at ? lat.at : lng.at) }
    : null;

  const signals: LiveSignal[] = all
    .filter((r) => !POSITION_SIGNALS.has(r.signal))
    .sort((a, b) => a.signal.localeCompare(b.signal))
    .map((r) => ({
      signal: r.signal, value: r.value, unit: r.unit, at: r.at.toISOString(),
      ageSeconds: age(r.at), stale: age(r.at) > SIGNAL_STALE_SECONDS, source: r.source,
    }));

  return {
    ...base, connection, lastReadingAt: last?.toISOString() ?? null, lastUploadAt: lastUpload?.toISOString() ?? null,
    running, location, signals,
  };
}
