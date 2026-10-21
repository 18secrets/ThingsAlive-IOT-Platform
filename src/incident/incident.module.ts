import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AlertModule } from '../alert/alert.module';
import { OutboxConsumer } from '../events/outbox-consumer';
import { IdentityModule } from '../identity/identity.module';
import { MailModule } from '../mail/mail.module';
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
    IncidentNotifyHandler, IncidentNotifyScheduler,
    // The outbox's one consumer, with its handlers listed here. The next event type
    // with a handler moves this to the events module and adds itself to the list.
    {
      provide: OutboxConsumer,
      useFactory: (ds: DataSource, escalated: IncidentNotifyHandler) => new OutboxConsumer(ds, [escalated]),
      inject: [DataSource, IncidentNotifyHandler],
    },
  ],
  exports: [IncidentRecordService],
})
export class IncidentModule {}
