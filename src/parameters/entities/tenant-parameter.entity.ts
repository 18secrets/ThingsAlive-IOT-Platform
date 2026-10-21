import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ParameterScope } from '../parameter-catalog';

/**
 * One value of one client parameter, at one scope, from one instant (task QPARAM1).
 *
 * Append-only, enforced by the database (`1758400000000-TenantParameters.ts`): a change
 * is a new row with a later `effective_from`, and clearing a value is a row whose
 * `value` is JSON `null`. The history is the audit trail — a cost that was edited in
 * place cannot answer "what did we think fuel cost when this report was run".
 *
 * Client-owned with no platform scope (D39). There is deliberately no platform read
 * path to this table.
 */
@Entity('tenant_parameter')
export class TenantParameter {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ type: 'text' })
  scope: ParameterScope;

  /** NULL for client; the plant id for site; the class slug; the equipment profile id. */
  @Column({ name: 'scope_ref', type: 'text', nullable: true })
  scopeRef: string | null;

  @Column({ type: 'text' })
  name: string;

  /** JSON `null` is a deliberate clear — the scope stops supplying a value and the next
   * scope up answers instead. */
  @Column({ type: 'jsonb' })
  value: unknown;

  @Column({ type: 'text', nullable: true })
  unit: string | null;

  @Column({ name: 'effective_from', type: 'timestamptz' })
  effectiveFrom: Date;

  @Column({ name: 'created_by', type: 'text' })
  createdBy: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
