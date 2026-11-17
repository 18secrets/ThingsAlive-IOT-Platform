import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Severity } from '../../common/severity';
import { DtcLamp, DtcProtocol } from './dtc-master.entity';

export type DtcEpisodeStatus = 'active' | 'cleared';

/**
 * A persistent episode of a diagnostic trouble code on a machine.
 *
 * Managed with debounce logic to prevent flapping on packet drops:
 * - Remains 'active' while code continues to be received in telemetry packets.
 * - Transitions to 'cleared' only when absent from consecutive packets or after an active window.
 * - Stays active if telemetry stops entirely (engine-off / key-off guard).
 * - Kept for 90 days in operational storage for diagnostic analysis.
 */
@Entity('device_dtc_episode')
@Index('ix_device_dtc_episode_tenant_active', ['tenantId', 'externalId', 'status'])
@Index('ix_device_dtc_episode_lookup', ['tenantId', 'externalId', 'code', 'status'])
@Index('ix_device_dtc_episode_history', ['tenantId', 'externalId', 'firstSeenAt'])
export class DeviceDtcEpisode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text', default: 'ta-2.0' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ type: 'text' })
  imei: string;

  @Column({ type: 'text' })
  protocol: DtcProtocol;

  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'int', nullable: true })
  spn: number | null;

  @Column({ type: 'int', nullable: true })
  fmi: number | null;

  @Column({ name: 'lamp_status', type: 'text', default: 'none' })
  lampStatus: DtcLamp;

  @Column({ type: 'text', default: 'medium' })
  severity: Severity;

  @Column({ type: 'text', default: 'active' })
  status: DtcEpisodeStatus;

  @Column({ name: 'first_seen_at', type: 'timestamptz' })
  firstSeenAt: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt: Date;

  @Column({ name: 'cleared_at', type: 'timestamptz', nullable: true })
  clearedAt: Date | null;

  @Column({ type: 'int', default: 1 })
  occurrences: number;

  @Column({ name: 'consecutive_missing_count', type: 'int', default: 0 })
  consecutiveMissingCount: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
