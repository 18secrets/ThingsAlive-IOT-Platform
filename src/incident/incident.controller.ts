import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { Severity } from '../common/severity';
import { WorkOrderPriority } from '../work/entities/work-order.entity';
import { IncidentRecordService } from './incident-record.service';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { IncidentService } from './incident.service';

class IncidentQuery {
  /** Only `open` exists in phase 1: with no incident entity there is no closed
   * incident to list, and accepting a value that silently means "open" would let a
   * caller believe otherwise. */
  @IsOptional()
  @IsIn(['open'])
  status?: 'open';
}

class RecordQuery {
  @IsOptional() @IsIn(['open', 'acknowledged', 'resolved', 'live']) status?: 'open' | 'acknowledged' | 'resolved' | 'live';
  @IsOptional() @IsString() externalId?: string;
}
class AssignBody { @IsOptional() @IsString() userId?: string | null; }
class ResolveBody { @IsString() @IsNotEmpty() note: string; }
class RaiseWorkBody {
  @IsString() @IsNotEmpty() title: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsIn(['low', 'normal', 'high', 'urgent']) priority?: WorkOrderPriority;
  @IsOptional() @IsString() assignedToUserId?: string | null;
  @IsOptional() @Type(() => Date) @IsDate() dueAt?: Date | null;
}
class PolicyBody {
  @IsInt() @Min(1) ackWithinMinutes: number;
  @IsInt() @Min(1) resolveWithinMinutes: number;
}

/**
 * Incident Management as a view (closeout §4). Gated like the alert list it is built
 * on (`prediction.read`); work orders are included only for a caller who may read them.
 */
@ApiTags('Incidents')
@Controller('incidents')
export class IncidentController {
  constructor(private readonly incidents: IncidentService, private readonly records: IncidentRecordService) {}

  // ------------------------------------------------------- the entity (phase 2)

  @Get('records')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Incident records: owner, status, SLA clocks. ?status=open|acknowledged|resolved|live' })
  listRecords(@CurrentScope() scope: RequestScope, @Query() query: RecordQuery) {
    return this.records.list(scope, query);
  }

  @Get('sla-policies')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'This account\'s response times per severity. None is no clock, not a default' })
  policies(@CurrentScope() scope: RequestScope) {
    return this.records.listPolicies(scope);
  }

  @Put('sla-policies/:severity')
  @Requires('parameters.write')
  @ApiOperation({ summary: 'Set minutes to acknowledge and to resolve for one severity; applies to incidents opened from now' })
  setPolicy(@CurrentScope() scope: RequestScope, @Param('severity') severity: Severity, @Body() body: PolicyBody) {
    return this.records.setPolicy(scope, severity, body.ackWithinMinutes, body.resolveWithinMinutes);
  }

  @Delete('sla-policies/:severity')
  @HttpCode(204)
  @Requires('parameters.write')
  @ApiOperation({ summary: 'Remove the response times for one severity' })
  deletePolicy(@CurrentScope() scope: RequestScope, @Param('severity') severity: Severity) {
    return this.records.deletePolicy(scope, severity);
  }

  @Get('records/:id')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'One incident: its alerts, the work raised on them, and its timeline' })
  getRecord(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.records.get(scope, id);
  }

  @Post('records/:id/acknowledge')
  @Requires('action.work')
  @ApiOperation({ summary: 'Acknowledge: somebody is on it. Acknowledges its open alerts too' })
  acknowledge(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.records.acknowledge(scope, id);
  }

  @Post('records/:id/assign')
  @Requires('action.assign')
  @ApiOperation({ summary: 'Give it an owner in this account, or none (userId: null)' })
  assign(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: AssignBody) {
    return this.records.assign(scope, id, body.userId ?? null);
  }

  @Post('records/:id/resolve')
  @Requires('action.work')
  @ApiOperation({ summary: 'Resolve with a note; resolves its alerts; refused while its work is unfinished' })
  resolve(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: ResolveBody) {
    return this.records.resolve(scope, id, body.note);
  }

  @Post('records/:id/work-orders')
  @Requires('action.assign')
  @ApiOperation({ summary: 'Raise a job on it, against its worst unresolved alert' })
  raiseWork(@CurrentScope() scope: RequestScope, @Param('id') id: string, @Body() body: RaiseWorkBody) {
    return this.records.raiseWork(scope, id, body);
  }

  @Get()
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Machines with an open alert: their alerts, their open jobs, the worst severity' })
  list(@CurrentScope() scope: RequestScope, @Query() _query: IncidentQuery) {
    return this.incidents.list(scope);
  }
}
