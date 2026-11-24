import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { can } from '../auth/capabilities';
import { SCOPE_RESOLVER, ScopeResolver } from '../auth/scope-resolver';
import { Plant } from '../equipment/entities/plant.entity';
import { EquipmentProfile } from '../equipment/equipment-profile.entity';
import { DomainEvent } from '../events/domain-event.entity';
import { NotificationDelivery } from '../events/notification-delivery.entity';
import { HandlerOutcome, OutboxHandler } from '../events/outbox-consumer';
import { AppUser } from '../identity/entities/app-user.entity';
import { MailService } from '../mail/mail.service';

export interface MachineRef { sourceSystem: string; externalId: string }

export interface FaultCodeRaisedPayload {
  episodeId: string;
  code: string;
  title: string;
  severity: string;
  deviceId: string;
  machine: MachineRef;
  /** When the code became active, by the reading's time. */
  at: string;
}

export interface LoggerOfflinePayload {
  deviceId: string;
  machine: MachineRef;
  lastUploadAt: string;
}

interface Recipient { id: string; email: string; fullName: string }

/**
 * Emails about a pump logger (Motor Monitor integration spec, 24 Nov 2026, "Alerts").
 *
 * Who is told is the incident escalation's level-2 answer (D45), for the same reason:
 * everyone in the account who can assign work on this machine, as the API would answer
 * for each of them today. A suspended user, an unaccepted invitation, or a site manager
 * whose sites do not include the pump is not told. One email per person per event,
 * recorded in `notification_delivery`, so a retry after one address failed does not
 * write to the others again.
 */
abstract class MotorNotifyHandler implements OutboxHandler {
  abstract readonly eventType: 'motor.fault_code_raised.v1' | 'motor.logger_offline.v1';
  protected readonly logger = new Logger(this.constructor.name);

  constructor(protected readonly mail: MailService, protected readonly resolver: ScopeResolver) {}

  /** The email, or `skip` with the reason it is no longer worth sending. */
  protected abstract compose(m: EntityManager, event: DomainEvent, where: { machineName: string; siteName: string | null; timeZone: string })
    : Promise<{ subject: string; text: (name: string) => string } | { skip: string }>;

  protected abstract machineOf(event: DomainEvent): MachineRef;

  async handle(m: EntityManager, event: DomainEvent, now: Date): Promise<HandlerOutcome> {
    const tenantId = event.tenantId;
    const ref = this.machineOf(event);
    const machine = await m.getRepository(EquipmentProfile).findOne({ where: { tenantId, sourceSystem: ref.sourceSystem, externalId: ref.externalId } });
    if (!machine) return { kind: 'failed', error: `machine ${ref.externalId} no longer exists` };
    const site = machine.plantId ? await m.getRepository(Plant).findOne({ where: { tenantId, id: machine.plantId } }) : null;
    const [tenant] = await m.query(`SELECT coalesce("time_zone", 'Asia/Kolkata') AS "tz" FROM "tenant" WHERE "tenant_id" = $1`, [tenantId]);

    const mail = await this.compose(m, event, { machineName: machine.name || ref.externalId, siteName: site?.name ?? null, timeZone: tenant?.tz ?? 'Asia/Kolkata' });
    if ('skip' in mail) {
      this.logger.log(`${event.eventType} ${event.id}: not sent, ${mail.skip}.`);
      return { kind: 'delivered' };
    }
    const recipients = await this.recipients(m, tenantId, ref.externalId);
    if (!recipients.length) return { kind: 'failed', error: 'nobody in the account can receive this alert' };

    const deliveries = m.getRepository(NotificationDelivery);
    const done = new Set((await deliveries.find({ where: { tenantId, eventId: event.id, channel: 'email' } })).map((d) => d.recipientUserId));
    let failed = 0;
    for (const r of recipients) {
      if (done.has(r.id)) continue;
      const ok = await this.mail.send({ to: r.email, subject: mail.subject, text: mail.text(r.fullName) });
      if (!ok) { failed += 1; continue; }
      await deliveries.createQueryBuilder().insert().into(NotificationDelivery)
        .values({ tenantId, eventId: event.id, recipientUserId: r.id, channel: 'email', sentAt: now })
        .orIgnore().execute();
    }
    // MailService answers false, not an exception, when mail is not configured or the
    // provider refused: a failure to deliver, never a success.
    return failed ? { kind: 'retry', error: `${failed} of ${recipients.length} email(s) were not accepted by the mail provider` } : { kind: 'delivered' };
  }

  private async recipients(m: EntityManager, tenantId: string, externalId: string): Promise<Recipient[]> {
    const users = await m.getRepository(AppUser).find({ where: { tenantId, status: 'active' } });
    const out: Recipient[] = [];
    for (const u of users) {
      if (!u.email) continue;
      try {
        const r = await this.resolver.resolve(tenantId, u.id);
        if (!r) continue;
        const scope = { tenantId, userId: u.id, roles: r.roles, isPlatformRole: false, capabilities: r.capabilities, plantIds: r.plantIds, equipmentIds: r.equipmentIds };
        if (scope.equipmentIds !== undefined && !scope.equipmentIds.includes(externalId)) continue;
        if (!can(scope, 'action.assign')) continue;
        out.push({ id: u.id, email: u.email, fullName: u.fullName });
      } catch {
        // The resolver refuses a person who would be refused at sign-in by throwing.
      }
    }
    return out;
  }
}

@Injectable()
export class MotorFaultNotifyHandler extends MotorNotifyHandler {
  readonly eventType = 'motor.fault_code_raised.v1' as const;

  constructor(mail: MailService, @Inject(SCOPE_RESOLVER) resolver: ScopeResolver) { super(mail, resolver); }

  protected machineOf(event: DomainEvent): MachineRef {
    return (event.payload as unknown as FaultCodeRaisedPayload).machine;
  }

  protected async compose(_m: EntityManager, event: DomainEvent, where: { machineName: string; siteName: string | null; timeZone: string }) {
    return faultCodeEmail(event.payload as unknown as FaultCodeRaisedPayload, where, this.mail.publicUrl());
  }
}

@Injectable()
export class MotorOfflineNotifyHandler extends MotorNotifyHandler {
  readonly eventType = 'motor.logger_offline.v1' as const;

  constructor(mail: MailService, @Inject(SCOPE_RESOLVER) resolver: ScopeResolver) { super(mail, resolver); }

  protected machineOf(event: DomainEvent): MachineRef {
    return (event.payload as unknown as LoggerOfflinePayload).machine;
  }

  protected async compose(m: EntityManager, event: DomainEvent, where: { machineName: string; siteName: string | null; timeZone: string }) {
    const p = event.payload as unknown as LoggerOfflinePayload;
    // Back before anyone could be told: a short outage the pump got over by itself is
    // not worth an email that arrives after it has ended.
    const [{ newer }] = await m.query(
      `SELECT EXISTS (SELECT 1 FROM "motor_upload_log" WHERE "device_id" = $1 AND "received_at" > $2) AS "newer"`,
      [p.deviceId, p.lastUploadAt]);
    if (newer) return { skip: `${p.deviceId} uploaded again before the alert went out` };
    return loggerOfflineEmail(p, where, this.mail.publicUrl());
  }
}

const local = (iso: string, timeZone: string) =>
  `${new Date(iso).toLocaleString('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' })} (${timeZone})`;

/**
 * The messages, as pure functions. Only what the machine page shows anyone who can open
 * it: the code, its time, the machine and site. No readings, no other machine.
 */
export function faultCodeEmail(
  p: Pick<FaultCodeRaisedPayload, 'code' | 'title' | 'severity' | 'at'>,
  where: { machineName: string; siteName: string | null; timeZone: string },
  link: string | null,
): { subject: string; text: (name: string) => string } {
  const place = where.siteName ? `${where.machineName} at ${where.siteName}` : where.machineName;
  return {
    subject: `${p.code} ${p.title} on ${where.machineName}`,
    text: (name: string) => [
      `Hello ${name},`,
      '',
      `Fault code ${p.code} (${p.title}, ${p.severity} severity) became active on ${place} at ${local(p.at, where.timeZone)}.`,
      '',
      'The code is worked out from the pump logger\'s readings by the same rules the device uses.',
      link ? `See the machine in Things Alive: ${link}` : 'See the machine in Things Alive.',
      '',
      'You are receiving this because you can assign work on this machine.',
    ].join('\n'),
  };
}

export function loggerOfflineEmail(
  p: Pick<LoggerOfflinePayload, 'deviceId' | 'lastUploadAt'>,
  where: { machineName: string; siteName: string | null; timeZone: string },
  link: string | null,
): { subject: string; text: (name: string) => string } {
  const place = where.siteName ? `${where.machineName} at ${where.siteName}` : where.machineName;
  return {
    subject: `Logger offline on ${where.machineName}`,
    text: (name: string) => [
      `Hello ${name},`,
      '',
      `The pump logger ${p.deviceId} on ${place} has not uploaded since ${local(p.lastUploadAt, where.timeZone)}.`,
      'It uploads every five minutes, so it has missed at least two. It may have lost power or its mobile network.',
      '',
      'The logger keeps its readings while offline and sends them when it reconnects.',
      link ? `See the machine in Things Alive: ${link}` : 'See the machine in Things Alive.',
      '',
      'You are receiving this because you can assign work on this machine.',
    ].join('\n'),
  };
}
