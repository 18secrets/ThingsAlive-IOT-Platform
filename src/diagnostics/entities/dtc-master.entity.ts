import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Severity } from '../../common/severity';

export type DtcProtocol = 'j1939' | 'obd2';
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

  @Column({ name: 'source_system', type: 'text', default: '1.0' })
  sourceSystem: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
