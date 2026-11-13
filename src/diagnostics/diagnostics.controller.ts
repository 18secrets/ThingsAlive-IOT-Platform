import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { DtcEpisodeService } from './services/dtc-episode.service';

@ApiTags('Diagnostics')
@Controller('diagnostics')
export class DiagnosticsController {
  constructor(private readonly dtcService: DtcEpisodeService) {}

  @Get('equipment/:externalId/active')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Active Diagnostic Trouble Codes (DTCs) on an equipment' })
  async getActive(
    @CurrentScope() scope: RequestScope,
    @Param('externalId') externalId: string,
  ) {
    return this.dtcService.getActiveEpisodes(scope.tenantId, externalId);
  }

  @Get('equipment/:externalId/history')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'DTC episode history on an equipment across shifts' })
  async getHistory(
    @CurrentScope() scope: RequestScope,
    @Param('externalId') externalId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.dtcService.getHistory(
      scope.tenantId,
      externalId,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }
}
