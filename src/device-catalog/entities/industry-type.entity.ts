import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type IndustryTypeStatus = 'active' | 'inactive';

/**
 * An industry a tool mapping is for (task QINDUSTRY). Things Alive's reference data,
 * global like `tool_mapping`. Inactive hides it from the picker; a mapping already
 * pointing at it keeps it. Deleting one in use is refused by the foreign key.
 */
@Entity('industry_type')
export class IndustryType {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  name: string;

  /** 2–10 uppercase letters or digits, unique. */
  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'text', default: 'active' })
  status: IndustryTypeStatus;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
