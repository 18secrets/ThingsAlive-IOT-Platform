import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { withTenantId, withTenantSession } from '../../scope/tenant-session';
import { EquipmentClassSensorRequirement } from '../../catalog/entities/equipment-class-sensor-requirement.entity';
import { EquipmentProfile } from '../../equipment/equipment-profile.entity';
import { DeviceInventory } from '../../inventory/entities/device-inventory.entity';
import { ToolMapping } from '../../device-catalog/entities/tool-mapping.entity';
import { Sensor } from '../../device-catalog/entities/sensor.entity';
import { SensorRoleCapability } from '../../device-catalog/entities/sensor-role-capability.entity';
import { SensorMapProjection } from '../../projection/entities/sensor-map-projection.entity';
import {
  SignalBindingDiscoveredBy, SignalBindingOrigin, SignalBindingVersion,
} from '../entities/signal-binding-version.entity';
import { TelemetryWindowReader } from '../../kpi/services/telemetry-window-reader';
import {
  chainForEquipment, ParameterRow, resolveFromRows, tenantStaleAfterSeconds,
} from '../../parameters/services/parameter-resolution';
import { resolveStaleAfterSeconds } from './signal-freshness';

/**
 * The contract's `missing_inputs.reason` enum. `unbound` and `mapping_required`
 * are still the only reasons `coverage()` itself produces — see its own
 * comment (task Q08S s3) for why `stale`/`no_readings` stay out of its
 * covered/missing classification. They are real now, just produced by
 * `KpiEvaluatorService` instead, which is where a KPI's own readiness already
 * depends on a specific signal having reported recently.
 */
export type MissingReason = 'unbound' | 'mapping_required' | 'stale' | 'no_readings';

export interface EquipmentRef {
  sourceSystem: string;
  externalId: string;
}

/** Per-signal freshness (task Q08S s3) — `lastReadingAt: null` is what makes
 * `no_readings` legible to a caller without it having to infer anything from
 * an absence. */
export interface SignalFreshness {
  staleAfterSeconds: number;
  lastReadingAt: string | null;
  secondsSinceLastReading: number | null;
}

export type CoveredRequirement = {
  measurementRole: string;
  componentScope: string;
  minCount: number;
  activeCount: number;
} & SignalFreshness;

export interface MissingRequirement extends SignalFreshness {
  measurementRole: string;
  componentScope: string;
  minCount: number;
  activeCount: number;
  reason: MissingReason;
}

export interface BlockedLayer {
  /** One of `equipment_class_sensor_requirement.enables` — the same vocabulary
   * the equipment-context contract's `intelligence_profile.layers[].layer` uses. */
  layer: string;
  missingInputs: string[];
}

export interface CoverageResult {
  equipment: EquipmentRef;
  at: string;
  covered: CoveredRequirement[];
  missing: MissingRequirement[];
  blockedLayers: BlockedLayer[];
}

export interface DiscoveryCandidate {
  signalKey: string;
  measurementRole: string;
  unit: string | null;
  imei: string | null;
  sensorName: string | null;
  sensorId: string | null;
  /**
   * The binding already in force or awaiting review for this signal from this logger,
   * if any. Without it the panel offered Propose and Activate again after either had
   * worked, and the tester read a successful call as a broken button (TC_129).
   */
  bindingStatus: 'proposed' | 'active' | null;
}

/** A candidate before its binding state is looked up. */
type RawCandidate = Omit<DiscoveryCandidate, 'bindingStatus'>;

export interface DiscoveryResult {
  equipment: EquipmentRef;
  /** Present in both sources, and agreeing on the signal. */
  matched: DiscoveryCandidate[];
  /** tool_mapping expects this channel; nothing in sensor_map answers it — a
   * commissioning fault. */
  expectedNotMapped: DiscoveryCandidate[];
  /** sensor_map is receiving this signal; no tool_mapping entry expected it — a
   * mapping someone has not finished. */
  mappedNotExpected: DiscoveryCandidate[];
}

export interface ProposeBindingInput {
  signalKey: string;
  measurementRole: string;
  componentId?: string;
  origin: SignalBindingOrigin;
  imei?: string | null;
  channel?: string | null;
  sensorInstanceId?: string | null;
  canonicalUnit: string;
  sourceUnit?: string | null;
  validFrom: Date;
  validTo?: Date | null;
  discoveredBy?: SignalBindingDiscoveredBy;
  discoveredFrom?: string | null;
}

/**
 * Coverage, discovery and resolve-at-event-time (task Q08S slice 2) — what closes
 * the gap between "a reading arrived" and "this equipment has this signal".
 *
 * Reads what QL1 (`equipment_class_sensor_requirement`) and Q08S slice 1
 * (`signal_binding_version` and its exclusion constraint) already built. No
 * migration belongs here.
 */
@Injectable()
export class SignalBindingService {
  private readonly telemetryReader = new TelemetryWindowReader();

  constructor(private readonly ds: DataSource) {}

  // ------------------------------------------------------------------- coverage

  /**
   * For one equipment, at one instant: required expected-signal requirements
   * against active primary bindings, per component_scope, against min_count.
   *
   * A requirement with nothing currently in force — never bound, or bound once
   * but past its closed validity window — is `unbound`: at this instant, neither
   * case has a binding covering it, which is what `unbound` literally means. One
   * partially satisfied by fewer bindings than `min_count` needs more mapping,
   * not a fresh one (`mapping_required`). `stale` and `no_readings` are reserved
   * for a later, telemetry-aware slice: this service only ever looks at
   * `signal_binding_version`, never `telemetry_reading`, so it can state that a
   * binding is missing but not that a bound signal has gone quiet — `stale`, per
   * the contract, is a binding that exists AND a sensor that has gone silent, a
   * different fact from nothing being bound right now.
   */
  async coverage(scope: RequestScope, equipment: EquipmentRef, at: Date = new Date()): Promise<CoverageResult> {
    return withTenantSession(this.ds, scope, async (m) => {
      const profile = await this.findEquipment(m, scope.tenantId, equipment);
      if (!profile.equipmentClassSlug || !profile.classVersion) return computeCoverage(equipment, at, [], [], new Map(), null);

      const requirements = await m.getRepository(EquipmentClassSensorRequirement).find({
        where: {
          classSlug: profile.equipmentClassSlug, classVersion: profile.classVersion,
          criticality: 'required',
        },
      });

      // Freshness by the binding's device, over the binding's window (task
      // QFIX-DEVICES) — not `device_inventory`'s IMEIs. The KPI evaluator reads the
      // same segments, so a signal cannot be ready on one widget and silent on the
      // one beside it. Discovery still starts from the inventory: that is a
      // different question (what could be bound), not this one (what is).
      const segments = await bindingSegments(
        m, scope.tenantId, equipment, [...new Set(requirements.map((r) => r.measurementRole))], { by: 'measurementRole' },
      );
      const latestBySignal = await this.telemetryReader.latestPerSignalInSegments(
        m, scope.tenantId, segments.map(({ signal, imei, from, to }) => ({ signal, imei, from, to })), at,
      );
      // The client's own threshold for this machine wins over the class's (task
      // QPARAM1 §4b) — the same order the KPI evaluator uses, so a signal cannot be
      // stale on one screen and fresh on another.
      const tenantStaleAfter = await tenantStaleAfterSeconds(m, scope.tenantId, profile, at);

      // One read for every requirement (task QPERF-COVERAGE §2), grouped below by the
      // same (role, component) the per-requirement query used to filter on.
      const allRows = requirements.length ? await m.getRepository(SignalBindingVersion).find({
        where: {
          tenantId: scope.tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId,
          measurementRole: In([...new Set(requirements.map((r) => r.measurementRole))]),
        },
      }) : [];

      return computeCoverage(equipment, at, requirements, allRows, latestBySignal, tenantStaleAfter);
    });
  }

  /**
   * `coverage` for every machine on a site page at once (task QTX1): the same answer,
   * per machine, from one read of each input instead of one per machine — profiles,
   * requirements, bindings and the stale-after parameter. The latest reading is still
   * one query per machine: the shared reader keys its answer by signal alone, and two
   * machines share signal names. The computation is `computeCoverage`, the function
   * `coverage` itself uses, so the two cannot disagree. Machines not in the account
   * are left out rather than refused: the page already chose which machines to ask about.
   */
  async coverageMany(
    scope: RequestScope, equipment: EquipmentRef[], at: Date = new Date(),
  ): Promise<Map<string, CoverageResult>> {
    const out = new Map<string, CoverageResult>();
    if (!equipment.length) return out;
    const key = (e: EquipmentRef) => `${e.sourceSystem}/${e.externalId}`;
    return withTenantSession(this.ds, scope, async (m) => {
      const wanted = new Set(equipment.map(key));
      const externalIds = [...new Set(equipment.map((e) => e.externalId))];
      const profiles = (await m.getRepository(EquipmentProfile).find({
        where: { tenantId: scope.tenantId, externalId: In(externalIds) },
      })).filter((p) => wanted.has(key(p)));

      const slugs = [...new Set(profiles.map((p) => p.equipmentClassSlug).filter((s): s is string => !!s))];
      const [requirements, bindings, parameterRows] = await Promise.all([
        slugs.length ? m.getRepository(EquipmentClassSensorRequirement).find({
          where: { classSlug: In(slugs), criticality: 'required' },
        }) : Promise.resolve([]),
        m.getRepository(SignalBindingVersion).find({ where: { tenantId: scope.tenantId, externalId: In(externalIds) } }),
        latestParameterRows(m, scope.tenantId, 'stale_after_seconds', at),
      ]);

      for (const profile of profiles) {
        const ref = { sourceSystem: profile.sourceSystem, externalId: profile.externalId };
        const reqs = requirements.filter((r) =>
          r.classSlug === profile.equipmentClassSlug && r.classVersion === profile.classVersion);
        if (!profile.equipmentClassSlug || !profile.classVersion) {
          out.set(key(ref), computeCoverage(ref, at, [], [], new Map(), null));
          continue;
        }
        const roles = new Set(reqs.map((r) => r.measurementRole));
        const rows = bindings.filter((b) => key(b) === key(ref) && roles.has(b.measurementRole));
        const segments = rows.filter((r) => r.isPrimary && r.status === 'active' && !!r.imei)
          .map((r) => ({ signal: r.measurementRole, imei: r.imei!, from: r.validFrom, to: r.validTo }));
        const latestBySignal = await this.telemetryReader.latestPerSignalInSegments(m, scope.tenantId, segments, at);
        const stale = resolveFromRows(parameterRows, chainForEquipment(profile), ['stale_after_seconds']).get('stale_after_seconds');
        out.set(key(ref), computeCoverage(
          ref, at, reqs, rows, latestBySignal, typeof stale?.value === 'number' ? stale.value : null,
        ));
      }
      return out;
    });
  }

  // ------------------------------------------------------------------ discovery

  /**
   * Two independent sources, never silently merged. `tool_mapping` (through the
   * claimed device's `tool_mapping_id`, expanded via `sensor_role_capability`) is
   * what a device profile expects to report; `sensor_map_projection` (through the
   * claimed device's IMEI) is what upstream actually maps. They disagree in the
   * field, and the disagreement — not a merged best guess — is the point.
   *
   * Read-only: this computes and returns the three sets without writing anything.
   * A candidate only becomes a `discovered_unreviewed` binding row when a person
   * proposes it through `POST .../bindings` — a `tool_mapping`-only candidate has
   * no IMEI to satisfy `ck_signal_binding_source` and could never become one.
   */
  async discover(scope: RequestScope, equipment: EquipmentRef): Promise<DiscoveryResult> {
    return withTenantSession(this.ds, scope, async (m) => {
      await this.findEquipment(m, scope.tenantId, equipment);

      const devices = await m.getRepository(DeviceInventory).find({
        where: { tenantId: scope.tenantId, equipmentExternalId: equipment.externalId },
      });

      const expected = await this.expectedFromToolMapping(m, devices);
      const actual = await this.actualFromSensorMap(m, scope.tenantId, devices);

      const expectedByKey = new Map(expected.map((c) => [c.signalKey, c]));
      const actualByKey = new Map(actual.map((c) => [c.signalKey, c]));

      const matched: RawCandidate[] = [];
      const expectedNotMapped: RawCandidate[] = [];
      for (const candidate of expected) {
        const found = actualByKey.get(candidate.signalKey);
        if (found) matched.push({ ...candidate, imei: found.imei, sensorName: found.sensorName });
        else expectedNotMapped.push(candidate);
      }

      const mappedNotExpected = actual.filter((c) => !expectedByKey.has(c.signalKey));

      // Open versions only: a superseded or rejected one is history, not state.
      const open = await m.getRepository(SignalBindingVersion).find({
        where: {
          tenantId: scope.tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId,
          validTo: IsNull(), status: In(['proposed', 'discovered_unreviewed', 'active']),
        },
      });
      const statusOf = (c: RawCandidate): DiscoveryCandidate['bindingStatus'] => {
        const mine = open.filter((b) => b.signalKey === c.signalKey && (c.imei === null || b.imei === c.imei));
        if (mine.some((b) => b.status === 'active')) return 'active';
        return mine.length ? 'proposed' : null;
      };
      const annotate = (list: RawCandidate[]): DiscoveryCandidate[] => list.map((c) => ({ ...c, bindingStatus: statusOf(c) }));

      return {
        equipment,
        matched: annotate(matched),
        expectedNotMapped: annotate(expectedNotMapped),
        mappedNotExpected: annotate(mappedNotExpected),
      };
    });
  }

  private async expectedFromToolMapping(
    m: EntityManager, devices: DeviceInventory[],
  ): Promise<RawCandidate[]> {
    const toolMappingIds = [...new Set(devices.map((d) => d.toolMappingId).filter((id): id is string => !!id))];
    if (!toolMappingIds.length) return [];

    const toolMappings = await m.getRepository(ToolMapping).find({ where: { id: In(toolMappingIds) } });
    const sensorIds = [...new Set(toolMappings.flatMap((t) => t.mappedSensors.map((s) => s.sensorId)))];
    if (!sensorIds.length) return [];

    const sensors = await m.getRepository(Sensor).find({ where: { id: In(sensorIds) } });
    const sensorNameById = new Map(sensors.map((s) => [s.id, s.sensorName]));
    const capabilities = await m.getRepository(SensorRoleCapability).find({ where: { sensorId: In(sensorIds) } });

    const out: RawCandidate[] = [];
    const seen = new Set<string>();
    for (const device of devices) {
      if (!device.toolMappingId) continue;
      const mapping = toolMappings.find((t) => t.id === device.toolMappingId);
      if (!mapping) continue;

      for (const ref of mapping.mappedSensors) {
        for (const parameterKey of ref.parameters) {
          const capability = capabilities.find(
            (c) => c.sensorId === ref.sensorId && (c.parameterKey === parameterKey || c.parameterKey === null),
          );
          if (!capability) continue;
          const key = `${capability.measurementRole}::${device.imei}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            signalKey: capability.measurementRole, measurementRole: capability.measurementRole,
            unit: capability.canonicalUnit, imei: device.imei,
            sensorName: sensorNameById.get(ref.sensorId) ?? null, sensorId: ref.sensorId,
          });
        }
      }
    }
    return out;
  }

  private async actualFromSensorMap(
    m: EntityManager, tenantId: string, devices: DeviceInventory[],
  ): Promise<RawCandidate[]> {
    const imeis = [...new Set(devices.map((d) => d.imei))];
    if (!imeis.length) return [];

    const rows = await m.getRepository(SensorMapProjection).find({
      where: { tenantId, imei: In(imeis) },
    });
    return rows.map((r) => ({
      signalKey: r.signal, measurementRole: r.signal, unit: r.unit,
      imei: r.imei, sensorName: r.sensorName, sensorId: null,
    }));
  }

  // -------------------------------------------------------------------- resolve

  /**
   * The one active primary binding whose validity contains `at`, or nothing. One
   * row or none, never a list. `ex_signal_binding_primary` guarantees at most one
   * — if this ever sees two, that guarantee has been violated (only possible by
   * writing outside the constraint, e.g. under `ta.bypass`), and papering over it
   * with "pick one" would attribute a reading to the wrong sensor silently.
   */
  async resolveBinding(
    tenantId: string, equipment: EquipmentRef, signalKey: string, componentId: string, at: Date,
  ): Promise<SignalBindingVersion | null> {
    return withTenantId(this.ds, tenantId, async (m) => {
      const rows = await m.getRepository(SignalBindingVersion).find({
        where: {
          tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId,
          signalKey, componentId, isPrimary: true, status: 'active',
        },
      });
      const inForce = rows.filter((r) => windowContains(r, at));
      if (inForce.length > 1) {
        throw new Error(
          `More than one active primary binding resolved for ${equipment.sourceSystem}/${equipment.externalId} `
            + `signal "${signalKey}" component "${componentId}" at ${at.toISOString()} — `
            + 'ex_signal_binding_primary should make this impossible.',
        );
      }
      return inForce[0] ?? null;
    });
  }

  // ------------------------------------------------------------- propose / activate

  /** Stages a candidate. Never active — see `activate` for the human act that is. */
  async propose(scope: RequestScope, equipment: EquipmentRef, input: ProposeBindingInput): Promise<SignalBindingVersion> {
    return withTenantSession(this.ds, scope, async (m) => {
      await this.findEquipment(m, scope.tenantId, equipment);
      this.assertValidWindow(equipment, input.signalKey, input.validFrom, input.validTo ?? null);

      const repo = m.getRepository(SignalBindingVersion);
      return repo.save(repo.create({
        tenantId: scope.tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId,
        signalKey: input.signalKey, measurementRole: input.measurementRole,
        componentId: input.componentId ?? '', origin: input.origin,
        imei: input.imei ?? null, channel: input.channel ?? null, sensorInstanceId: input.sensorInstanceId ?? null,
        canonicalUnit: input.canonicalUnit, sourceUnit: input.sourceUnit ?? null,
        validFrom: input.validFrom, validTo: input.validTo ?? null,
        isPrimary: false,
        status: input.discoveredBy && input.discoveredBy !== 'manual' ? 'discovered_unreviewed' : 'proposed',
        discoveredFrom: input.discoveredFrom ?? null, discoveredBy: input.discoveredBy ?? 'manual',
      }));
    });
  }

  /**
   * The human action: confirms a binding as THE primary source for its
   * (signal, component), audited by recording who and when directly on the row —
   * `ex_signal_binding_primary` is what refuses a second, overlapping primary; a
   * violation surfaces as the database's own error, not a check duplicated here.
   */
  async activate(scope: RequestScope, equipment: EquipmentRef, input: ProposeBindingInput): Promise<SignalBindingVersion> {
    return withTenantSession(this.ds, scope, async (m) => {
      await this.findEquipment(m, scope.tenantId, equipment);
      this.assertValidWindow(equipment, input.signalKey, input.validFrom, input.validTo ?? null);

      const repo = m.getRepository(SignalBindingVersion);
      const now = new Date();

      // Check if an existing active primary binding already exists for the same signal & component
      const existing = await repo.findOne({
        where: {
          tenantId: scope.tenantId,
          sourceSystem: equipment.sourceSystem,
          externalId: equipment.externalId,
          signalKey: input.signalKey,
          componentId: input.componentId ?? '',
          isPrimary: true,
          status: 'active',
        },
      });

      if (existing) {
        // If it is already active with the same device/channel, it is already satisfied
        if (
          existing.imei === (input.imei ?? null) &&
          existing.channel === (input.channel ?? null) &&
          existing.sensorInstanceId === (input.sensorInstanceId ?? null)
        ) {
          return existing;
        }
        // If replacing with a new primary binding, retire the previous one by setting its validTo
        existing.validTo = input.validFrom && input.validFrom > existing.validFrom ? input.validFrom : now;
        existing.status = 'superseded';
        existing.isPrimary = false;
        await repo.save(existing);
      }

      try {
        return await repo.save(repo.create({
          tenantId: scope.tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId,
          signalKey: input.signalKey, measurementRole: input.measurementRole,
          componentId: input.componentId ?? '', origin: input.origin,
          imei: input.imei ?? null, channel: input.channel ?? null, sensorInstanceId: input.sensorInstanceId ?? null,
          canonicalUnit: input.canonicalUnit, sourceUnit: input.sourceUnit ?? null,
          validFrom: input.validFrom, validTo: input.validTo ?? null,
          isPrimary: true, status: 'active',
          discoveredFrom: input.discoveredFrom ?? null, discoveredBy: input.discoveredBy ?? 'manual',
          approvedBy: scope.userId, approvedAt: now,
        }));
      } catch (err: any) {
        if (err?.message?.includes('ex_signal_binding_primary') || err?.code === '23P01') {
          throw new ConflictException('An active primary binding already exists for this signal on this equipment.');
        }
        throw err;
      }
    });
  }

  // ----------------------------------------------------------------------- shared

  private async findEquipment(m: EntityManager, tenantId: string, equipment: EquipmentRef): Promise<EquipmentProfile> {
    const profile = await m.getRepository(EquipmentProfile).findOne({
      where: { tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId },
    });
    if (!profile) throw new NotFoundException('No such equipment in this account.');
    return profile;
  }

  /**
   * The one thing the database's own range constructor refuses without naming a
   * table, column or constraint ("range lower bound must be less than or equal to
   * range upper bound"). Checked here so the message names the equipment, the
   * signal and both timestamps instead.
   */
  private assertValidWindow(equipment: EquipmentRef, signalKey: string, validFrom: Date, validTo: Date | null): void {
    if (validTo !== null && validTo <= validFrom) {
      throw new BadRequestException(
        `Binding for equipment ${equipment.sourceSystem}/${equipment.externalId} signal "${signalKey}": `
          + `valid_to (${validTo.toISOString()}) must be after valid_from (${validFrom.toISOString()}).`,
      );
    }
  }
}

export interface BindingSegment {
  /** The signal as the caller names it — `signalKey` or `measurementRole`, per `by`. */
  signal: string;
  imei: string;
  from: Date;
  to: Date | null;
  expectedPeriodSeconds: number | null;
}

/**
 * Which device produced each signal on this machine, and when (task QFIX-DEVICES): the
 * active primary bindings, as segments. **The binding is the authority for this
 * question** — not `device_projection` (where 1.0 thinks a device is) and not
 * `device_inventory` (where the customer claimed it). Both of those hold only the
 * current link; only a binding's validity window knows when a device moved.
 *
 * A binding with no IMEI (a virtual or model-derived source) has no device to read
 * and contributes no segment. One query for every signal the caller needs.
 */
export async function bindingSegments(
  m: EntityManager, tenantId: string, equipment: EquipmentRef, signals: string[],
  opts: { by: 'signalKey' | 'measurementRole'; componentId?: string },
): Promise<BindingSegment[]> {
  if (!signals.length) return [];
  const rows = await m.getRepository(SignalBindingVersion).find({
    where: {
      tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId,
      [opts.by]: In(signals), isPrimary: true, status: 'active',
      ...(opts.componentId !== undefined ? { componentId: opts.componentId } : {}),
    },
  });
  return rows.filter((r) => !!r.imei).map((r) => ({
    signal: opts.by === 'signalKey' ? r.signalKey : r.measurementRole,
    imei: r.imei!, from: r.validFrom, to: r.validTo, expectedPeriodSeconds: r.expectedPeriodSeconds,
  }));
}

/**
 * The devices a machine's bindings place on it at some point in `[from, to]`, whatever
 * the signal (task QFIX-DEVICES-2) — for the readers that ask "which loggers are on this
 * machine" rather than "which device produced this signal". Same authority as
 * `bindingSegments`: not `device_projection`, which is where 1.0 thinks a device is, and
 * which let prediction, chains, recommendations, the service forecast and Availability
 * read a different machine's devices than the page beside them.
 */
export async function boundImeis(
  m: EntityManager, tenantId: string, equipment: EquipmentRef, from: Date, to: Date,
): Promise<string[]> {
  const rows = await m.getRepository(SignalBindingVersion).find({
    where: {
      tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId, isPrimary: true, status: 'active',
    },
  });
  return [...new Set(rows
    .filter((r) => !!r.imei && r.validFrom <= to && (r.validTo === null || r.validTo > from))
    .map((r) => r.imei!))];
}

/** Segments that overlap `[from, to]` — a signal is bound for a window when some
 * binding was in force during it, which is what lets history after a move still be
 * read for the machine that had the device at the time. */
export const overlapping = (segments: BindingSegment[], from: Date, to: Date) =>
  segments.filter((s) => s.from <= to && (s.to === null || s.to > from));

/** [valid_from, valid_to) — half-open, replicated in application code to match
 * the generated `validity` column's own semantics exactly. */
function windowContains(binding: SignalBindingVersion, at: Date): boolean {
  return binding.validFrom <= at && (binding.validTo === null || binding.validTo > at);
}

/**
 * Coverage for one machine from inputs already read (task QTX1) — the body `coverage`
 * always had, lifted out unchanged so `coverageMany` computes exactly the same thing.
 */
function computeCoverage(
  equipment: EquipmentRef, at: Date, requirements: EquipmentClassSensorRequirement[],
  allRows: SignalBindingVersion[], latestBySignal: Map<string, Date>, tenantStaleAfter: number | null,
): CoverageResult {
  const covered: CoveredRequirement[] = [];
  const missing: MissingRequirement[] = [];
  const blockedByLayer = new Map<string, Set<string>>();

  for (const req of requirements) {
    const rows = allRows.filter((r) => r.measurementRole === req.measurementRole && r.componentId === req.componentScope);

    const activeNow = rows.filter((r) => r.isPrimary && r.status === 'active' && windowContains(r, at));
    const activeCount = activeNow.length;

    const staleAfterSeconds = resolveStaleAfterSeconds(req, tenantStaleAfter);
    const lastReadingAt = latestBySignal.get(req.measurementRole) ?? null;
    const secondsSinceLastReading = lastReadingAt ? (at.getTime() - lastReadingAt.getTime()) / 1000 : null;
    const freshness: SignalFreshness = {
      staleAfterSeconds,
      lastReadingAt: lastReadingAt ? lastReadingAt.toISOString() : null,
      secondsSinceLastReading,
    };

    if (activeCount >= req.minCount) {
      // Annotated with freshness (task Q08S s3), not reclassified by it.
      // `covered` stays a binding-count question, exactly as Q08S s2 built
      // it — existing callers already rely on "enough bindings exist" being
      // the whole of what `covered` means (see
      // `test/signal-binding-coverage.spec.ts`'s own "reports a whole-
      // machine requirement as covered", which asserts this against a
      // binding with no telemetry seeded at all). Whether a currently-bound
      // signal that has gone quiet should also move to `missing` here is a
      // real open question — deliberately not decided unilaterally by
      // editing those tests to seed telemetry they were never written to
      // need. QCE2's `KpiEvaluatorService` is where staleness already gates
      // whether a KPI reads `ready`.
      covered.push({
        measurementRole: req.measurementRole, componentScope: req.componentScope,
        minCount: req.minCount, activeCount, ...freshness,
      });
      continue;
    }

    // `activeCount === 0` covers two situations this slice cannot tell apart
    // through the contract's enum, and both are `unbound`: no row was ever
    // created, or an active primary row exists but no window it declares
    // covers `at` (a closed validity window). A closed window means nothing
    // is bound at this instant, which is `unbound`'s literal meaning, not a
    // data-freshness complaint.
    //
    // `activeCount > 0` but still under `min_count` is real partial coverage
    // — at least one confirmed binding is in force, more mapping is what
    // closes the gap — so that case alone is `mapping_required`.
    const reason: MissingReason = activeCount === 0 ? 'unbound' : 'mapping_required';

    missing.push({
      measurementRole: req.measurementRole, componentScope: req.componentScope,
      minCount: req.minCount, activeCount, reason, ...freshness,
    });
    for (const layer of req.enables) {
      const set = blockedByLayer.get(layer) ?? new Set<string>();
      set.add(req.measurementRole);
      blockedByLayer.set(layer, set);
    }
  }

  const blockedLayers: BlockedLayer[] = [...blockedByLayer.entries()]
    .map(([layer, roles]) => ({ layer, missingInputs: [...roles].sort() }))
    .sort((a, b) => a.layer.localeCompare(b.layer));

  return { equipment, at: at.toISOString(), covered, missing, blockedLayers };
}

/** The latest row per (scope, scope_ref) for one parameter name, at `at` — what
 * `resolveFromRows` needs to answer every machine's chain from one read. */
async function latestParameterRows(m: EntityManager, tenantId: string, name: string, at: Date): Promise<ParameterRow[]> {
  const raw: (Omit<ParameterRow, 'effectiveFrom'> & { effectiveFrom: Date | string })[] = await m.query(
    `SELECT DISTINCT ON ("scope", COALESCE("scope_ref", ''))
            "scope", "scope_ref" AS "scopeRef", "name", "value", "unit", "effective_from" AS "effectiveFrom"
       FROM "tenant_parameter"
      WHERE "tenant_id" = $1 AND "name" = $2 AND "effective_from" <= $3
      ORDER BY "scope", COALESCE("scope_ref", ''), "effective_from" DESC`,
    [tenantId, name, at],
  );
  return raw.map((r) => ({ ...r, effectiveFrom: new Date(r.effectiveFrom) }));
}
