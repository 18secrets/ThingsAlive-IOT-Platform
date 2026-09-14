import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * What one person is assigned to (tasks P1-21, P1-84).
 *
 * Two tables rather than one with a `kind` column, because they are read by
 * different questions and indexed differently: "which sites does this person run"
 * and "who is on this machine" are not the same query, and a polymorphic table
 * answers both slowly while type-checking neither.
 *
 * Assignment is the only thing that grants access below the account level, and it
 * holds until it is removed. An operator sees a machine because it is assigned to
 * them, not because a job is open on it — so access does not blink out when a work
 * order closes, and does not have to be reinstated when the next one opens.
 */
@Entity('user_plant_access')
@Index('uq_user_plant_access', ['tenantId', 'userId', 'plantId'], { unique: true })
@Index('ix_user_plant_access_user', ['tenantId', 'userId'])
export class UserPlantAccess {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /**
   * A site in this account.
   *
   * This was an upstream identifier when sites lived only in the existing platform,
   * and the note left here then — that the key would survive equipment moving into
   * 2.0 — was wrong. Sites became rows with their own ids, so an assignment points at
   * a row. Keeping the old pair would have meant a site could be renamed upstream and
   * quietly take somebody's access with it.
   */
  @Column({ name: 'plant_id', type: 'uuid' })
  plantId: string;

  @Column({ name: 'granted_by', type: 'text', nullable: true })
  grantedBy: string | null;

  @CreateDateColumn({ name: 'granted_at', type: 'timestamptz' })
  grantedAt: Date;
}

@Entity('user_equipment_access')
@Index('uq_user_equipment_access', ['tenantId', 'userId', 'sourceSystem', 'equipmentExternalId'], { unique: true })
@Index('ix_user_equipment_access_user', ['tenantId', 'userId'])
@Index('ix_user_equipment_access_asset', ['tenantId', 'sourceSystem', 'equipmentExternalId'])
export class UserEquipmentAccess {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'equipment_external_id', type: 'text' })
  equipmentExternalId: string;

  @Column({ name: 'granted_by', type: 'text', nullable: true })
  grantedBy: string | null;

  @CreateDateColumn({ name: 'granted_at', type: 'timestamptz' })
  grantedAt: Date;
}
