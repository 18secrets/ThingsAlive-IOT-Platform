import { Type } from 'class-transformer';
import {
  IsArray, IsIn, IsISO8601, IsNumber, IsObject, IsOptional, IsString, Matches,
  MaxLength, MinLength, ValidateNested,
} from 'class-validator';

/**
 * The payload contracts between the existing platform and 2.0 (task P1-42).
 *
 * Written and validated now, while the producer is a seed file. When the real
 * producer arrives it publishes these shapes and nothing downstream changes — that
 * is the whole point of writing them before the integration rather than during it.
 *
 * Every envelope carries an explicit version. A consumer that cannot recognise a
 * version refuses the batch rather than interpreting unfamiliar fields.
 */
export const EQUIPMENT_SNAPSHOT_V1 = 'equipment-snapshot/v1';
export const TELEMETRY_READING_V1 = 'telemetry-reading/v1';

/** IMEIs are 14–17 digits in the wild. Enforced here so a blank never becomes a key. */
const IMEI_PATTERN = /^[0-9]{14,17}$/;

export class EquipmentSnapshotItem {
  @IsString() @MinLength(1) @MaxLength(200)
  externalId: string;

  @IsString() @MinLength(1)
  externalClientId: string;

  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  classId?: string;

  @IsOptional() @IsString()
  plantExternalId?: string;

  @IsOptional() @IsString()
  category?: string;

  @IsOptional() @IsISO8601()
  sourceUpdatedAt?: string;

  /** The upstream record verbatim, for fields 2.0 has no column for yet. */
  @IsOptional() @IsObject()
  raw?: Record<string, unknown>;
}

export class DeviceSnapshotItem {
  @IsString() @MinLength(1)
  externalId: string;

  @IsString() @MinLength(1)
  externalClientId: string;

  @Matches(IMEI_PATTERN, { message: 'imei must be 14-17 digits' })
  imei: string;

  @IsOptional() @IsString()
  equipmentExternalId?: string;

  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsISO8601()
  sourceUpdatedAt?: string;

  @IsOptional() @IsObject()
  raw?: Record<string, unknown>;
}

export class SensorMapSnapshotItem {
  @IsString() @MinLength(1)
  externalId: string;

  @IsString() @MinLength(1)
  externalClientId: string;

  @Matches(IMEI_PATTERN, { message: 'imei must be 14-17 digits' })
  imei: string;

  @IsString() @MinLength(1)
  signal: string;

  @IsOptional() @IsString()
  sensorName?: string;

  @IsOptional() @IsString()
  unit?: string;

  @IsOptional() @IsISO8601()
  sourceUpdatedAt?: string;

  @IsOptional() @IsObject()
  raw?: Record<string, unknown>;
}

export class EquipmentSnapshotEnvelope {
  @IsIn([EQUIPMENT_SNAPSHOT_V1])
  contract: string;

  @IsString()
  sourceSystem: string;

  /** full = the complete population, safe to reconcile against. delta = changes only. */
  @IsIn(['full', 'delta'])
  mode: 'full' | 'delta';

  @IsISO8601()
  generatedAt: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => EquipmentSnapshotItem)
  equipment: EquipmentSnapshotItem[];

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DeviceSnapshotItem)
  devices?: DeviceSnapshotItem[];

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SensorMapSnapshotItem)
  sensorMap?: SensorMapSnapshotItem[];
}

export class TelemetryReadingItem {
  @Matches(IMEI_PATTERN, { message: 'imei must be 14-17 digits' })
  imei: string;

  @IsString() @MinLength(1)
  signal: string;

  @IsNumber()
  value: number;

  @IsOptional() @IsString()
  unit?: string;

  /** The logger's clock. Stored alongside the platform's own (task P1-46). */
  @IsISO8601()
  sourceTimestamp: string;
}

export class TelemetryBatchEnvelope {
  @IsIn([TELEMETRY_READING_V1])
  contract: string;

  @IsString()
  sourceSystem: string;

  @IsIn(['live', 'replayed', 'simulated'])
  source: 'live' | 'replayed' | 'simulated';

  @IsArray() @ValidateNested({ each: true }) @Type(() => TelemetryReadingItem)
  readings: TelemetryReadingItem[];
}
