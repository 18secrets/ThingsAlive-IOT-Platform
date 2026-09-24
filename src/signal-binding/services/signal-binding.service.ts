import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
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

/**
 * The subset of the contract's `missing_inputs.reason` enum this task names. Only
 * `unbound` and `mapping_required` are ever produced by this slice — see
 * `coverage()`'s own comment for why `stale` and `no_readings` are declared but
 * unreachable until a telemetry-aware slice can tell "bound but silent" from
 * "nothing bound".
 */
export type MissingReason = 'unbound' | 'mapping_required' | 'stale' | 'no_readings';

export interface EquipmentRef {
  sourceSystem: string;
  externalId: string;
}

export interface CoveredRequirement {
  measurementRole: string;
  componentScope: string;
  minCount: number;
  activeCount: number;
}

export interface MissingRequirement {
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
}

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

      const covered: CoveredRequirement[] = [];
      const missing: MissingRequirement[] = [];
      const blockedByLayer = new Map<string, Set<string>>();

      if (profile.equipmentClassSlug && profile.classVersion) {
        const requirements = await m.getRepository(EquipmentClassSensorRequirement).find({
          where: {
            classSlug: profile.equipmentClassSlug, classVersion: profile.classVersion,
            criticality: 'required',
          },
        });

        for (const req of requirements) {
          const rows = await m.getRepository(SignalBindingVersion).find({
            where: {
              tenantId: scope.tenantId, sourceSystem: equipment.sourceSystem, externalId: equipment.externalId,
              measurementRole: req.measurementRole, componentId: req.componentScope,
            },
          });

          const activeNow = rows.filter((r) => r.isPrimary && r.status === 'active' && windowContains(r, at));
          const activeCount = activeNow.length;

          if (activeCount >= req.minCount) {
            covered.push({
              measurementRole: req.measurementRole, componentScope: req.componentScope,
              minCount: req.minCount, activeCount,
            });
            continue;
          }

          // `activeCount === 0` covers two situations this slice cannot tell apart
          // through the contract's enum, and both are `unbound`: no row was ever
          // created, or an active primary row exists but no window it declares
          // covers `at` (a closed validity window). Neither is `stale` — in the
          // contract, `stale` means a binding exists AND the sensor has gone
          // quiet, a telemetry-freshness fact this service never checks (it reads
          // only `signal_binding_version`, never `telemetry_reading`). A closed
          // window means nothing is bound at this instant, which is `unbound`'s
          // literal meaning, not a data-freshness complaint. None of the other six
          // reasons (mapping_required, no_primary_selected, calibration_expired,
          // calibration_unknown, unit_unresolved, no_readings) fit it either, so
          // `stale` joins `no_readings` as unreachable from this slice — both wait
          // on a telemetry-aware slice to become producible.
          //
          // `activeCount > 0` but still under `min_count` is real partial coverage
          // — at least one confirmed binding is in force, more mapping is what
          // closes the gap — so that case alone is `mapping_required`.
          const reason: MissingReason = activeCount === 0 ? 'unbound' : 'mapping_required';

          missing.push({
            measurementRole: req.measurementRole, componentScope: req.componentScope,
            minCount: req.minCount, activeCount, reason,
          });
          for (const layer of req.enables) {
            const set = blockedByLayer.get(layer) ?? new Set<string>();
            set.add(req.measurementRole);
            blockedByLayer.set(layer, set);
          }
        }
      }

      const blockedLayers: BlockedLayer[] = [...blockedByLayer.entries()]
        .map(([layer, roles]) => ({ layer, missingInputs: [...roles].sort() }))
        .sort((a, b) => a.layer.localeCompare(b.layer));

      return { equipment, at: at.toISOString(), covered, missing, blockedLayers };
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

      const matched: DiscoveryCandidate[] = [];
      const expectedNotMapped: DiscoveryCandidate[] = [];
      for (const candidate of expected) {
        const found = actualByKey.get(candidate.signalKey);
        if (found) matched.push({ ...candidate, imei: found.imei, sensorName: found.sensorName });
        else expectedNotMapped.push(candidate);
      }

      const mappedNotExpected = actual.filter((c) => !expectedByKey.has(c.signalKey));

      return { equipment, matched, expectedNotMapped, mappedNotExpected };
    });
  }

  private async expectedFromToolMapping(
    m: EntityManager, devices: DeviceInventory[],
  ): Promise<DiscoveryCandidate[]> {
    const toolMappingIds = [...new Set(devices.map((d) => d.toolMappingId).filter((id): id is string => !!id))];
    if (!toolMappingIds.length) return [];

    const toolMappings = await m.getRepository(ToolMapping).find({ where: { id: In(toolMappingIds) } });
    const sensorIds = [...new Set(toolMappings.flatMap((t) => t.mappedSensors.map((s) => s.sensorId)))];
    if (!sensorIds.length) return [];

    const sensors = await m.getRepository(Sensor).find({ where: { id: In(sensorIds) } });
    const sensorNameById = new Map(sensors.map((s) => [s.id, s.sensorName]));
    const capabilities = await m.getRepository(SensorRoleCapability).find({ where: { sensorId: In(sensorIds) } });

    const out: DiscoveryCandidate[] = [];
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
  ): Promise<DiscoveryCandidate[]> {
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
      return repo.save(repo.create({
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

/** [valid_from, valid_to) — half-open, replicated in application code to match
 * the generated `validity` column's own semantics exactly. */
function windowContains(binding: SignalBindingVersion, at: Date): boolean {
  return binding.validFrom <= at && (binding.validTo === null || binding.validTo > at);
}
