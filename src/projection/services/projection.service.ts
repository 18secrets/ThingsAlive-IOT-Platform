import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  DeviceSnapshotItem, EquipmentSnapshotEnvelope, EquipmentSnapshotItem, SensorMapSnapshotItem,
} from '../contracts/contracts';
import { DeviceProjection } from '../entities/device-projection.entity';
import { EquipmentProjection } from '../entities/equipment-projection.entity';
import { ProjectionRejection } from '../entities/projection-rejection.entity';
import { SensorMapProjection } from '../entities/sensor-map-projection.entity';
import { TenantMap } from '../entities/tenant-map.entity';
import { checksumOf } from './checksum';

export interface SyncResult {
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  markedMissing: number;
}

const EMPTY: SyncResult = { inserted: 0, updated: 0, unchanged: 0, rejected: 0, markedMissing: 0 };

/**
 * Applies a snapshot to the projections (tasks P1-41, P1-43, P1-47).
 *
 * Two modes, both from the first version. `delta` is the routine path; `full` also
 * reconciles, marking anything the source no longer reports. Incremental-only sync
 * means the first drift incident has no repair tool, which is a bad moment to start
 * writing one.
 *
 * Idempotent by construction: applying the same snapshot twice changes nothing the
 * second time, because the checksum decides whether a row is rewritten.
 */
@Injectable()
export class ProjectionService {
  private readonly logger = new Logger(ProjectionService.name);

  constructor(
    @InjectRepository(EquipmentProjection) private readonly equipment: Repository<EquipmentProjection>,
    @InjectRepository(DeviceProjection) private readonly devices: Repository<DeviceProjection>,
    @InjectRepository(SensorMapProjection) private readonly sensorMap: Repository<SensorMapProjection>,
    @InjectRepository(TenantMap) private readonly tenants: Repository<TenantMap>,
    @InjectRepository(ProjectionRejection) private readonly rejections: Repository<ProjectionRejection>,
  ) {}

  async apply(envelope: EquipmentSnapshotEnvelope, now = new Date()): Promise<Record<string, SyncResult>> {
    const tenantByClient = await this.tenantLookup(envelope.sourceSystem);

    const equipment = await this.applyKind(
      'equipment', envelope, envelope.equipment ?? [], this.equipment, tenantByClient, now,
      (item: EquipmentSnapshotItem) => ({
        name: item.name ?? null,
        classId: item.classId ?? null,
        plantExternalId: item.plantExternalId ?? null,
        category: item.category ?? null,
      }),
    );
    const devices = await this.applyKind(
      'device', envelope, envelope.devices ?? [], this.devices, tenantByClient, now,
      (item: DeviceSnapshotItem) => ({
        imei: item.imei,
        equipmentExternalId: item.equipmentExternalId ?? null,
        name: item.name ?? null,
      }),
    );
    const sensorMap = await this.applyKind(
      'sensor_map', envelope, envelope.sensorMap ?? [], this.sensorMap, tenantByClient, now,
      (item: SensorMapSnapshotItem) => ({
        imei: item.imei,
        signal: item.signal,
        sensorName: item.sensorName ?? null,
        unit: item.unit ?? null,
      }),
    );

    return { equipment, devices, sensorMap };
  }

  /** How stale the freshest row for a tenant is, in milliseconds. Null when empty. */
  async stalenessMs(tenantId: string, now = new Date()): Promise<number | null> {
    const row = await this.equipment.findOne({
      where: { tenantId },
      order: { syncedAt: 'DESC' },
    });
    return row ? now.getTime() - row.syncedAt.getTime() : null;
  }

  private async tenantLookup(sourceSystem: string): Promise<Map<string, string>> {
    const rows = await this.tenants.find({ where: { sourceSystem } });
    return new Map(rows.map((r) => [r.externalClientId, r.tenantId]));
  }

  private async applyKind<T extends { id: string }>(
    kind: string,
    envelope: EquipmentSnapshotEnvelope,
    items: any[],
    repo: Repository<any>,
    tenantByClient: Map<string, string>,
    now: Date,
    fields: (item: any) => Record<string, unknown>,
  ): Promise<SyncResult> {
    const result: SyncResult = { ...EMPTY };
    if (!items.length && envelope.mode === 'delta') return result;

    const seen: string[] = [];

    for (const item of items) {
      const tenantId = tenantByClient.get(item.externalClientId);
      if (!tenantId) {
        // Refused, not defaulted. An untenanted row is a row every tenant can read.
        await this.rejections.save(
          this.rejections.create({
            sourceSystem: envelope.sourceSystem,
            kind,
            externalId: item.externalId ?? null,
            reason: `No tenant mapped for client "${item.externalClientId}" in source "${envelope.sourceSystem}".`,
            payload: item,
          }),
        );
        result.rejected += 1;
        continue;
      }

      const body = fields(item);
      const checksum = checksumOf({ ...body, tenantId, raw: item.raw ?? null });
      seen.push(item.externalId);

      const existing = await repo.findOne({
        where: { sourceSystem: envelope.sourceSystem, externalId: item.externalId },
      });

      if (existing && existing.checksum === checksum && existing.status === 'live') {
        result.unchanged += 1;
        continue;
      }

      const row = {
        ...(existing ?? {}),
        sourceSystem: envelope.sourceSystem,
        externalId: item.externalId,
        tenantId,
        payload: item.raw ?? {},
        sourceUpdatedAt: item.sourceUpdatedAt ? new Date(item.sourceUpdatedAt) : null,
        syncedAt: now,
        checksum,
        status: 'live' as const,
        ...body,
      };
      await repo.save(repo.create(row));
      existing ? (result.updated += 1) : (result.inserted += 1);
    }

    // A full snapshot is the complete population, so anything absent is gone upstream.
    // Marked rather than deleted: 2.0 rows may reference it, and a disappearance is
    // itself worth seeing.
    if (envelope.mode === 'full') {
      const stale = await repo.find({
        where: { sourceSystem: envelope.sourceSystem, status: 'live' },
      });
      const missing = stale.filter((r: any) => !seen.includes(r.externalId));
      if (missing.length) {
        await repo.update({ id: In(missing.map((m: any) => m.id)) }, { status: 'missing', syncedAt: now });
        result.markedMissing = missing.length;
        this.logger.warn(
          `${kind}: ${missing.length} row(s) absent from a full snapshot of "${envelope.sourceSystem}" — marked missing.`,
        );
      }
    }

    return result;
  }
}
