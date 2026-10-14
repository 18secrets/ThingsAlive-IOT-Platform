import { Module } from '@nestjs/common';
import { AlertModule } from '../alert/alert.module';
import { WorkModule } from '../work/work.module';
import { IncidentController } from './incident.controller';
import { IncidentEscalationScheduler } from './incident-escalation.scheduler';
import { IncidentRecordService } from './incident-record.service';
import { IncidentService } from './incident.service';

/** The view over the two producers (closeout §4), and the incident entity beside it (phase 2). */
@Module({
  imports: [AlertModule, WorkModule],
  controllers: [IncidentController],
  providers: [IncidentService, IncidentRecordService, IncidentEscalationScheduler],
  exports: [IncidentRecordService],
})
export class IncidentModule {}
