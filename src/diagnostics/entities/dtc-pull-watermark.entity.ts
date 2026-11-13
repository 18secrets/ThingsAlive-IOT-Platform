import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Tracks the last pulled packet timestamp and ID per IMEI from 1.0.
 *
 * Ensures that DTC telemetry pulls resume exactly where they left off
 * across process restarts.
 */
@Entity('dtc_pull_watermark')
export class DtcPullWatermark {
  @PrimaryColumn({ type: 'text' })
  imei: string;

  @Column({ name: 'last_packet_id', type: 'bigint', nullable: true })
  lastPacketId?: string | null;

  @Column({ name: 'last_packet_time', type: 'timestamptz' })
  lastPacketTime: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
