import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Where a machine has been, and who moved it (task P1-86).
 *
 * Moving equipment between sites is the one edit on the register that changes what
 * other people can see: a site manager gains an asset and another loses one, silently
 * and immediately, because their scope is derived rather than listed. An edit with
 * that reach needs a row saying who made it.
 *
 * It is also the question maintenance asks first. A machine that failed six months
 * after arriving from a coastal site has a history worth reading, and a single
 * mutable `plant_id` column keeps none of it.
 */
@Entity('equipment_placement_event')
@Index('ix_equipment_placement_asset', ['tenantId', 'sourceSystem', 'externalId', 'at'])
@Index('ix_equipment_placement_plant', ['tenantId', 'toPlantId', 'at'])
export class EquipmentPlacementEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ name: 'from_plant_id', type: 'uuid', nullable: true })
  fromPlantId: string | null;

  @Column({ name: 'to_plant_id', type: 'uuid', nullable: true })
  toPlantId: string | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ name: 'actor_user_id', type: 'text' })
  actorUserId: string;

  @CreateDateColumn({ name: 'at', type: 'timestamptz' })
  at: Date;
}
