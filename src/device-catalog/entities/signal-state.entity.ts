import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One state of a categorical signal and the code it arrives as (task QCAT1,
 * `1758510000000-SignalStates.ts`). Platform reference data — no tenant.
 */
@Entity('signal_state')
export class SignalState {
  @PrimaryColumn({ name: 'measurement_role', type: 'text' })
  measurementRole: string;

  @PrimaryColumn({ type: 'text' })
  state: string;

  @Column({ type: 'int' })
  code: number;

  @Column({ name: 'updated_by', type: 'text' })
  updatedBy: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
