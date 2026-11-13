import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { DtcEpisodeService, EquipmentFaultsResponse } from './services/dtc-episode.service';

@ApiTags('Diagnostics')
@Controller('diagnostics')
export class DiagnosticsController {
  constructor(private readonly dtcService: DtcEpisodeService) {}

  @Get('equipment/:sourceSystem/:externalId/faults')
  @Requires('prediction.read')
  @ApiOperation({ summary: 'Equipment diagnostic fault codes (active and history) enriched with master catalog' })
  async getFaults(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ): Promise<EquipmentFaultsResponse> {
    return this.dtcService.getEquipmentFaults(scope, sourceSystem, externalId);
  }
}
