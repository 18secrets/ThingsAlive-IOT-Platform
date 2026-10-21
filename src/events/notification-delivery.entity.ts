import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type NotificationChannel = 'email';

/**
 * One message sent about one event to one person (task QNOTIFY1). Unique on
 * (tenant, event, recipient, channel), which is what stops a second email when two
 * passes meet. See `1760900000000-IncidentNotifier.ts`.
 */
@Entity('notification_delivery')
export class NotificationDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'text' })
  tenantId: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ name: 'recipient_user_id', type: 'uuid' })
  recipientUserId: string;

  @Column({ type: 'text' })
  channel: NotificationChannel;

  @Column({ name: 'sent_at', type: 'timestamptz', default: () => 'now()' })
  sentAt: Date;
}
