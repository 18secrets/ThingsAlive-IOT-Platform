import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

/** Vani's three severities. Ours are mapped onto these once, where a call is requested. */
export type VaniSeverity = 'critical' | 'warning' | 'info';

/** Pending until Vani answers; then accepted (it owns the call), rejected (422) or failed (gave up). */
export type VaniCallState = 'pending' | 'accepted' | 'rejected' | 'failed';

export const VANI_OUTCOMES = [
  'completed_spoke_with_customer',
  'voicemail_dropped',
  'voicemail_not_delivered',
  'no_answer',
  'failed',
] as const;
export type VaniOutcome = (typeof VANI_OUTCOMES)[number];

/**
 * Which Vani account a tenant is. Vani's registry is Vani's: registration is done by
 * Vani operations, and this row only records the id they registered us under. See
 * `1763600000000-VaniVoice.ts`.
 */
@Entity('vani_account_link')
export class VaniAccountLink {
  @PrimaryColumn({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'vani_account_id', type: 'text' })
  vaniAccountId: string;

  /** Optional cross-check. Left empty, Vani calls the account's primary number. */
  @Column({ name: 'customer_phone', type: 'text', nullable: true })
  customerPhone: string | null;

  /** Sent with each trigger, so Vani's stored copy going stale cannot lose an outcome. */
  @Column({ name: 'callback_url', type: 'text', nullable: true })
  callbackUrl: string | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}

/** The machine id and spoken name Vani has registered for one of our machines. */
@Entity('vani_machine_link')
export class VaniMachineLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'source_system', type: 'text' })
  sourceSystem: string;

  @Column({ name: 'external_id', type: 'text' })
  externalId: string;

  @Column({ name: 'machine_id', type: 'text' })
  machineId: string;

  /** Said aloud on the call: "Diesel Generator DG-01", never "DG_01_GENSET". */
  @Column({ name: 'spoken_name', type: 'text' })
  spokenName: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}

/**
 * One alert we asked Vani to phone about, and Vani's answer. The alert id is the
 * `event_id` Vani dedupes on, so this row and Vani's call flow are one-to-one.
 */
@Entity('vani_call')
export class VaniCall {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'alert_event_id', type: 'uuid' })
  alertEventId: string;

  @Column({ name: 'vani_account_id', type: 'text' })
  vaniAccountId: string;

  @Column({ name: 'machine_id', type: 'text' })
  machineId: string;

  @Column({ type: 'text' })
  severity: VaniSeverity;

  /** Exactly what was POSTed. Fixed once written; a retry resends it unchanged. */
  @Column({ type: 'jsonb' })
  request: Record<string, unknown>;

  @Column({ type: 'text', default: 'pending' })
  state: VaniCallState;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'http_status', type: 'int', nullable: true })
  httpStatus: number | null;

  @Column({ name: 'trigger_id', type: 'text', nullable: true })
  triggerId: string | null;

  @Column({ name: 'call_id', type: 'text', nullable: true })
  callId: string | null;

  /** Vani's own `status`: queued, deferred, duplicate, or a policy outcome. */
  @Column({ name: 'vani_status', type: 'text', nullable: true })
  vaniStatus: string | null;

  @Column({ type: 'text', nullable: true })
  disposition: string | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /** When Vani will dial a deferred call by itself. Nothing here acts on it. */
  @Column({ name: 'retry_at', type: 'timestamptz', nullable: true })
  retryAt: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}

/** What Vani reported after one call attempt, kept as received. */
@Entity('vani_call_outcome')
export class VaniCallOutcome {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'alert_event_id', type: 'uuid' })
  alertEventId: string;

  @Column({ type: 'int' })
  attempt: number;

  @Column({ name: 'call_id', type: 'text', nullable: true })
  callId: string | null;

  @Column({ type: 'text' })
  outcome: VaniOutcome;

  @Column({ type: 'text', nullable: true })
  summary: string | null;

  @Column({ name: 'duration_s', type: 'double precision', nullable: true })
  durationS: number | null;

  @Column({ name: 'called_at', type: 'timestamptz', nullable: true })
  calledAt: Date | null;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'now()' })
  receivedAt: Date;
}
