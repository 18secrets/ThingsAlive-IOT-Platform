import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AlertModule } from '../alert/alert.module';
import { OutboxConsumer } from '../events/outbox-consumer';
import { IdentityModule } from '../identity/identity.module';
import { MailModule } from '../mail/mail.module';
import { MotorFaultNotifyHandler, MotorOfflineNotifyHandler } from '../motor-ingest/motor-alert-notify.handler';
import { WorkModule } from '../work/work.module';
import { IncidentController } from './incident.controller';
import { IncidentEscalationScheduler } from './incident-escalation.scheduler';
import { IncidentNotifyHandler } from './incident-notify.handler';
import { IncidentNotifyScheduler } from './incident-notify.scheduler';
import { IncidentRecordService } from './incident-record.service';
import { IncidentService } from './incident.service';

/** The view over the two producers (closeout §4), and the incident entity beside it (phase 2). */
@Module({
  imports: [AlertModule, WorkModule, MailModule, IdentityModule],
  controllers: [IncidentController],
  providers: [
    IncidentService, IncidentRecordService, IncidentEscalationScheduler,
    IncidentNotifyHandler, IncidentNotifyScheduler, MotorFaultNotifyHandler, MotorOfflineNotifyHandler,
    // The outbox's one consumer, with its handlers listed here. The pump logger's alerts
    // join it rather than starting a second consumer: one drain, one switch
    // (INCIDENT_NOTIFY_ENABLED), one backoff. Their handlers need only mail and the
    // scope resolver, both already here; moving the consumer to the events module is
    // the next step if a handler ever needs something this module does not have.
    {
      provide: OutboxConsumer,
      useFactory: (ds: DataSource, escalated: IncidentNotifyHandler, fault: MotorFaultNotifyHandler, offline: MotorOfflineNotifyHandler) =>
        new OutboxConsumer(ds, [escalated, fault, offline]),
      inject: [DataSource, IncidentNotifyHandler, MotorFaultNotifyHandler, MotorOfflineNotifyHandler],
    },
  ],
  exports: [IncidentRecordService],
})
export class IncidentModule {}
