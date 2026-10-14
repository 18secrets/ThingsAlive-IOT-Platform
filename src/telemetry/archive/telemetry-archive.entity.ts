import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** One Parquet object of one account's month (task QARCH1). See `1760300000000-TelemetryArchive.ts`. */
@Entity('telemetry_archive')
export class TelemetryArchive {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  /** The first of the month, as `YYYY-MM-DD`. */
  @Column({ type: 'date' })
  month: string;

  @Column({ type: 'int' })
  part: number;

  @Column({ name: 'object_key', type: 'text' })
  objectKey: string;

  @Column({ name: 'row_count', type: 'bigint' })
  rowCount: string;

  @Column({ type: 'text' })
  checksum: string;

  @Column({ name: 'byte_size', type: 'bigint' })
  byteSize: string;

  @Column({ name: 'exported_at', type: 'timestamptz' })
  exportedAt: Date;

  /** Set only once the object was read back and matched; until then it proves nothing. */
  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @Column({ name: 'verify_error', type: 'text', nullable: true })
  verifyError: string | null;
}
