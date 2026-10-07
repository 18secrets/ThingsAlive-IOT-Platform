import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
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

/**
 * Incident Management as a view (closeout §4). Gated like the alert list it is built
 * on (`prediction.read`); work orders are included only for a caller who may read them.
 */
@ApiTags('Incidents')
@Controller('incidents')
export class IncidentController {
  constructor(private readonly incidents: IncidentService) {}

  @Get()
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Machines with an open alert: their alerts, their open jobs, the worst severity' })
  list(@CurrentScope() scope: RequestScope, @Query() _query: IncidentQuery) {
    return this.incidents.list(scope);
  }
}
