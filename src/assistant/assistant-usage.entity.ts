import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** One account's assistant spend on one UTC day (task QCHAT1). See `1760600000000-AssistantUsage.ts`. */
@Entity('assistant_usage')
export class AssistantUsage {
  @PrimaryColumn({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @PrimaryColumn({ type: 'date' })
  day: string;

  @Column({ type: 'bigint', default: 0 })
  tokens: string;

  @Column({ type: 'int', default: 0 })
  requests: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
