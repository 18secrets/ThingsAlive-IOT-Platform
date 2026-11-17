import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Severity } from '../../common/severity';
import { DtcLamp } from './dtc-master.entity';

/**
 * A pump or motor fault code (P101 …), 2.0's own: the library Master Admin keeps
 * (FaultCodeLibrary1765300000000). Vehicle codes are 1.0's and live in
 * `dtc_master_catalog`; the two are shaped differently, so they do not share a table.
 */
@Entity('fault_code_motor')
export class MotorFaultCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** P and three digits; the first digit names the area of the pump set. */
  @Column({ type: 'text', unique: true })
  code: string;

  /** The fault, as the card's title reads it. */
  @Column({ type: 'text' })
  description: string;

  /** What the technician sees or hears at the pump. */
  @Column({ type: 'text', nullable: true })
  symptom: string | null;

  @Column({ type: 'text', nullable: true })
  causes: string | null;

  @Column({ type: 'text', nullable: true })
  remedies: string | null;

  /** How the fault is found: the logger's rule, or the technician's test. */
  @Column({ type: 'text', nullable: true })
  detection: string | null;

  @Column({ name: 'found_by', type: 'text', nullable: true })
  foundBy: 'logger' | 'technician' | null;

  @Column({ type: 'text', default: 'medium' })
  severity: Severity;

  @Column({ type: 'text', default: 'none' })
  lamp: DtcLamp;

  /** Retired, never deleted: fault history still points at the code. */
  @Column({ name: 'retired_at', type: 'timestamptz', nullable: true })
  retiredAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;
}
