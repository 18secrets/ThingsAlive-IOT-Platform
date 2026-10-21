import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { can } from '../auth/capabilities';
import { SCOPE_RESOLVER, ScopeResolver } from '../auth/scope-resolver';
import { RequestScope } from '../auth/types/request-scope';
import { Plant } from '../equipment/entities/plant.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { DomainEvent } from '../events/domain-event.entity';
import { NotificationDelivery } from '../events/notification-delivery.entity';
import { HandlerOutcome, OutboxHandler } from '../events/outbox-consumer';
import { AppUser } from '../identity/entities/app-user.entity';
import { MailService } from '../mail/mail.service';
import { IncidentEvent } from './entities/incident-link.entities';
import { Incident } from './entities/incident.entity';

export interface EscalatedPayload {
  incidentId: string;
  level: 1 | 2;
  reason: 'acknowledgement_overdue' | 'resolution_overdue';
  severity: string;
  machine: { sourceSystem: string; externalId: string };
  ownerUserId: string | null;
}

interface Recipient {
  id: string;
  email: string;
  fullName: string;
}

/**
 * Tells people that an incident escalated (task QNOTIFY1, answers recorded as D45).
 *
 * Who, decided once: level 1 (acknowledgement overdue) goes to the incident's owner,
 * or, with no owner who can see the machine, to everyone who can assign work
 * (`action.assign`); level 2 (resolution overdue) goes to the owner and everyone who
 * can assign work. "Can" means what the API would say for that person today: each
 * candidate is resolved through the same `ScopeResolver` the auth guard uses, so a
 * suspended user, an invited one who never signed in, or a site manager whose sites do
 * not include the machine is not told — never a list kept somewhere else that drifts
 * from the roles.
 *
 * The incident is read again at send time. One resolved since it escalated, or a
 * level-1 escalation acknowledged since, sends nothing, and the timeline says why.
 * Each recipient gets one email, recorded in `notification_delivery`; a retry skips
 * those already recorded, so a send that failed for one person is not repeated for
 * the others.
 */
@Injectable()
export class IncidentNotifyHandler implements OutboxHandler {
  readonly eventType = 'incident.escalated.v1' as const;
  private readonly logger = new Logger(IncidentNotifyHandler.name);

  constructor(
    private readonly mail: MailService,
    @Inject(SCOPE_RESOLVER) private readonly resolver: ScopeResolver,
  ) {}

  async handle(m: EntityManager, event: DomainEvent, now: Date): Promise<HandlerOutcome> {
    const p = event.payload as unknown as EscalatedPayload;
    const tenantId = event.tenantId;
    const incident = await m.getRepository(Incident).findOne({ where: { tenantId, id: p.incidentId } });
    if (!incident) return { kind: 'failed', error: `incident ${p.incidentId} no longer exists` };

    const skip = incident.status === 'resolved' ? 'resolved'
      : p.level === 1 && incident.acknowledgedAt ? 'acknowledged' : null;
    if (skip) {
      await this.timeline(m, incident, 'notification_skipped', now, { level: p.level, reason: skip, eventId: event.id });
      return { kind: 'delivered' };
    }

    const recipients = await this.recipients(m, incident, p.level);
    if (!recipients.length) {
      await this.timeline(m, incident, 'notification_skipped', now, { level: p.level, reason: 'no_recipient', eventId: event.id });
      return { kind: 'failed', error: 'nobody in the account can receive this escalation' };
    }

    const deliveries = m.getRepository(NotificationDelivery);
    const done = new Set((await deliveries.find({ where: { tenantId, eventId: event.id, channel: 'email' } }))
      .map((d) => d.recipientUserId));
    const mail = await this.compose(m, incident, p, now);

    const sent: string[] = [];
    let failed = 0;
    for (const r of recipients) {
      if (done.has(r.id)) continue;
      const ok = await this.mail.send({ to: r.email, subject: mail.subject, text: mail.text(r.fullName) });
      if (!ok) { failed += 1; continue; }
      // Recorded only once the provider accepted it. The unique index is the backstop
      // if two passes ever reach the same event; the second insert is skipped, not raised.
      await deliveries.createQueryBuilder().insert().into(NotificationDelivery)
        .values({ tenantId, eventId: event.id, recipientUserId: r.id, channel: 'email', sentAt: now })
        .orIgnore().execute();
      sent.push(r.id);
    }
    if (sent.length) {
      await this.timeline(m, incident, 'notified', now, { level: p.level, channel: 'email', recipients: sent, eventId: event.id });
    }
    if (failed) {
      // MailService answers false rather than throwing when mail is not configured or the
      // provider refused. That is a failure to deliver, never a success.
      return { kind: 'retry', error: `${failed} of ${recipients.length} email(s) were not accepted by the mail provider` };
    }
    return { kind: 'delivered' };
  }

  private async recipients(m: EntityManager, incident: Incident, level: 1 | 2): Promise<Recipient[]> {
    const users = await m.getRepository(AppUser).find({ where: { tenantId: incident.tenantId, status: 'active' } });
    const resolved = await Promise.all(users.map(async (u) => ({ u, scope: await this.scopeOf(incident, u) })));
    const sees = resolved.filter((x) => x.scope && (x.scope.equipmentIds === undefined
      || x.scope.equipmentIds.includes(incident.externalId)));
    const owner = sees.find((x) => x.u.id === incident.ownerUserId);
    const assigners = sees.filter((x) => can(x.scope!, 'action.assign'));

    const chosen = level === 1 ? (owner ? [owner] : assigners) : [...(owner ? [owner] : []), ...assigners];
    const seen = new Set<string>();
    return chosen.filter((x) => x.u.email && !seen.has(x.u.id) && seen.add(x.u.id))
      .map((x) => ({ id: x.u.id, email: x.u.email, fullName: x.u.fullName }));
  }

  /** What the API would let this person do today, or null if it would let them do nothing. */
  private async scopeOf(incident: Incident, u: AppUser): Promise<RequestScope | null> {
    try {
      const r = await this.resolver.resolve(incident.tenantId, u.id);
      if (!r) return null;
      return {
        tenantId: incident.tenantId, userId: u.id, roles: r.roles, isPlatformRole: false,
        capabilities: r.capabilities, plantIds: r.plantIds, equipmentIds: r.equipmentIds,
      };
    } catch {
      // The resolver refuses a suspended account, an unaccepted invitation or a missing
      // role by throwing; each is a person who would be refused at sign-in, not told.
      return null;
    }
  }

  private async compose(m: EntityManager, incident: Incident, p: EscalatedPayload, now: Date) {
    const machine = await m.getRepository(EquipmentProfile).findOne({
      where: { tenantId: incident.tenantId, sourceSystem: incident.sourceSystem, externalId: incident.externalId },
    });
    const site = machine?.plantId
      ? await m.getRepository(Plant).findOne({ where: { tenantId: incident.tenantId, id: machine.plantId } })
      : null;
    return escalationEmail({
      machineName: machine?.name || incident.externalId,
      siteName: site?.name ?? null,
      severity: incident.severity,
      level: p.level,
      dueAt: p.level === 2 ? incident.resolveDueAt : incident.ackDueAt,
      now,
      link: this.mail.publicUrl() ? `${this.mail.publicUrl()}/incident-management` : null,
    });
  }

  private async timeline(m: EntityManager, incident: Incident, kind: 'notified' | 'notification_skipped',
    at: Date, detail: Record<string, unknown>): Promise<void> {
    await m.getRepository(IncidentEvent).insert({ tenantId: incident.tenantId, incidentId: incident.id, kind, actor: 'system', at, detail });
  }
}

/**
 * The message, as a pure function. Only what the incident screen shows anyone who can
 * open it: no readings, no other machine, nothing from another account.
 */
export function escalationEmail(i: {
  machineName: string; siteName: string | null; severity: string; level: 1 | 2;
  dueAt: Date | null; now: Date; link: string | null;
}): { subject: string; text: (name: string) => string } {
  const clock = i.level === 2 ? 'resolved' : 'acknowledged';
  const where = i.siteName ? `${i.machineName} at ${i.siteName}` : i.machineName;
  const late = i.dueAt ? overdueBy(i.now.getTime() - i.dueAt.getTime()) : null;
  const subject = `Escalated: ${i.severity} incident on ${i.machineName} not ${clock} in time`;
  return {
    subject,
    text: (name: string) => [
      `Hello ${name},`,
      '',
      `A ${i.severity}-severity incident on ${where} was not ${clock} within its time limit`
        + `${late ? ` and is now ${late} overdue` : ''}. It has been escalated to level ${i.level}.`,
      '',
      i.link ? `Open it here: ${i.link}` : 'Open it from Incident Management in Things Alive.',
      '',
      'You are receiving this because you own the incident or can assign work in this account.',
    ].join('\n'),
  };
}

function overdueBy(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
