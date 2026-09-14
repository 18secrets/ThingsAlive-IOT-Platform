import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** What was done. Free text describes it; this decides whether it resets the clock. */
export type ServiceKind = 'scheduled' | 'unscheduled' | 'overhaul' | 'meter-replaced';

/**
 * A service that was performed, and where the meter stood when it was (task P4-07).
 *
 * Without this table the only way to say how many hours a machine has run since its
 * last service is the absolute meter reading, which is right exactly until the first
 * time anybody services a machine off-schedule — and then wrong forever, silently,
 * for that machine.
 *
 * `meter_reading` is stored raw, in the unit the logger was reporting at the time,
 * alongside that unit. Converting on the way in would bake in whatever the calibration
 * believed on the day the row was written, and a calibration that is later corrected
 * cannot reach back through a converted number. The raw reading is what the fitter
 * read off the machine; it stays that.
 *
 * `meter-replaced` is a kind rather than a flag because it is not a service: it is the
 * event that makes every earlier reading incomparable, and a screen that shows it as
 * maintenance would have somebody arguing about an interval that was never worked.
 */
@Entity('equipment_service_record')
@Index('ix_service_record_asset', ['tenantId', 'sourceSystem', 'externalId', 'performedAt'])
export class EquipmentServiceRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ name: 'performed_at', type: 'timestamptz' })
  performedAt: Date;

  @Column({ type: 'text', default: 'scheduled' })
  kind: ServiceKind;

  /** As read off the machine, in the unit the logger reported then. Never converted. */
  @Column({ name: 'meter_reading', type: 'double precision', nullable: true })
  meterReading: number | null;

  @Column({ name: 'meter_unit', type: 'text', nullable: true })
  meterUnit: string | null;

  /** The job this closed, when it came from one rather than from a form. */
  @Column({ name: 'work_order_id', type: 'uuid', nullable: true })
  workOrderId: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'recorded_by', type: 'text', nullable: true })
  recordedBy: string | null;

  @CreateDateColumn({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt: Date;
}
