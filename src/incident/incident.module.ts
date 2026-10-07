import { Module } from '@nestjs/common';
import { AlertModule } from '../alert/alert.module';
import { WorkModule } from '../work/work.module';
import { IncidentController } from './incident.controller';
import { IncidentService } from './incident.service';

/** Imports the two producers and owns no table (closeout §4). */
@Module({
  imports: [AlertModule, WorkModule],
  controllers: [IncidentController],
  providers: [IncidentService],
})
export class IncidentModule {}
