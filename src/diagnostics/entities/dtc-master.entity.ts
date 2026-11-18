import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Severity } from '../../common/severity';

/** `pcode` is the pump logger's own P-codes (P101, P401 …), never OBD-II's (P0101). */
export type DtcProtocol = 'j1939' | 'obd2' | 'pcode';
export type DtcLamp = 'red_stop' | 'amber_warning' | 'protect' | 'mil' | 'none';

@Entity('dtc_master_catalog')
@Index('ix_dtc_master_spn_fmi', ['spn', 'fmi'])
export class DtcMasterCatalog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  protocol: DtcProtocol;

  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'int', nullable: true })
  spn: number | null;

  @Column({ type: 'int', nullable: true })
  fmi: number | null;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'text', default: 'none' })
  lamp: DtcLamp;

  @Column({ type: 'text', default: 'medium' })
  severity: Severity;

  @Column({ type: 'text', nullable: true })
  causes: string | null;

  @Column({ type: 'text', nullable: true })
  remedies: string | null;

  /** 1.0's `source_type`: the unit that raises the code (VehicleCodeSource1765500000000). */
  @Column({ name: 'source_unit', type: 'text', nullable: true })
  sourceUnit: string | null;

  /** 1.0's `dtc_code`: the maker's own code for the fault. */
  @Column({ name: 'oem_code', type: 'text', nullable: true })
  oemCode: string | null;

  // From the engine makers' sheets (VehicleCodesOwned1765600000000): what a technician
  // needs at the machine, beyond the fault's cause and fix.
  @Column({ type: 'text', nullable: true })
  sensor: string | null;

  @Column({ type: 'text', nullable: true })
  location: string | null;

  @Column({ name: 'pin_details', type: 'text', nullable: true })
  pinDetails: string | null;

  @Column({ name: 'voltage_range', type: 'text', nullable: true })
  voltageRange: string | null;

  @Column({ name: 'signal_range', type: 'text', nullable: true })
  signalRange: string | null;

  @Column({ name: 'diagnostic_aids', type: 'text', nullable: true })
  diagnosticAids: string | null;

  @Column({ type: 'text', nullable: true })
  troubleshooting: string | null;

  @Column({ name: 'vehicle_reaction', type: 'text', nullable: true })
  vehicleReaction: string | null;

  /** Where the code came from: 1.0's copy (before 17 Nov), or 2.0 (FaultCodeLibrary1765300000000). */
  @Column({ name: 'source_system', type: 'text', default: '1.0' })
  sourceSystem: string;

  /** A 2.0 vehicle code no longer used: retired, never deleted (FaultCodeEditing1765400000000). */
  @Column({ name: 'retired_at', type: 'timestamptz', nullable: true })
  retiredAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
