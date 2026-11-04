import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { Weekday } from '../services/shift-window';

export interface ShiftTemplateShift {
  name: string;
  startMinute: number;
  endMinute: number;
  days: Weekday[];
  timeZone: string;
}

/** A library set of shifts, applied to a machine as copies (`1763500000000-ShiftTemplates`). */
@Entity('shift_template')
export class ShiftTemplate {
  @PrimaryColumn({ type: 'text' })
  slug: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'jsonb' })
  shifts: ShiftTemplateShift[];

  @Column({ type: 'text', default: 'published' })
  status: 'published' | 'retired';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
