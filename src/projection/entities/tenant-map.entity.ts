import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * The authoritative mapping from an external client identifier to a 2.0 tenant
 * (task P1-49).
 *
 * Every cross-system lookup needs this. Without one table owning the answer, each
 * caller invents its own guess — and a projected row whose tenant was guessed wrong
 * is a row the wrong customer can read.
 */
@Entity('tenant_map')
@Index('uq_tenant_map_source', ['sourceSystem', 'externalClientId'], { unique: true })
export class TenantMap {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Which upstream system the identifier belongs to, e.g. 'iot-platform-1'. */
  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_client_id', type: 'text' })
  externalClientId: string;

  @Column({ name: 'tenant_id', type: 'text' })
  @Index('ix_tenant_map_tenant')
  tenantId: string;

  @Column({ name: 'display_name', type: 'text', nullable: true })
  displayName: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
