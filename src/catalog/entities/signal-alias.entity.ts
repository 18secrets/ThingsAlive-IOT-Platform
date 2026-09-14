import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One name a signal is known by upstream, mapped to the canonical name (task P1-01).
 *
 * The same measurement arrives as `fuel_level`, `FuelLevel`, `fuel_pct` and `FUEL`
 * depending on which logger firmware and which receiver produced it. Without one
 * table owning the answer, each consumer invents its own normalisation, and a
 * scenario that requires `fuel_level` silently never fires for the fleet whose
 * loggers spell it differently — a failure that looks like "no faults detected".
 *
 * Platform-owned, like the rest of the catalog. An alias is a fact about a device
 * family, not about a customer.
 */
@Entity('signal_alias')
@Index('uq_signal_alias', ['sourceSystem', 'alias'], { unique: true })
@Index('ix_signal_alias_canonical', ['canonical'])
export class SignalAlias {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Which upstream system spells it this way. '*' means every source. */
  @Column({ name: 'source_system', type: 'text', default: '*' })
  sourceSystem: string;

  /** Stored lower-cased; resolution is case-insensitive because firmware is not. */
  @Column({ type: 'text' })
  alias: string;

  @Column({ type: 'text' })
  canonical: string;

  @Column({ type: 'text', nullable: true })
  unit: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;
}
