import { Controller, Get, Query, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { MotorIngestService } from './motor-ingest.service';

/**
 * The motor loggers' recent data, at the path the logger contract documents
 * (`/api/motor/recent`, unversioned), narrowed to the caller's own loggers. The loggers
 * post to the receiver (`motor_logger_http_server.py`), not here.
 */
@ApiTags('Motor loggers')
@Controller({ version: VERSION_NEUTRAL })
export class MotorIngestController {
  constructor(private readonly ingest: MotorIngestService) {}

  @Get('motor/recent')
  @Requires('device.read')
  @ApiOperation({ summary: 'Newest motor logger readings, devices and uploads, for this account\'s loggers' })
  recent(
    @CurrentScope() scope: RequestScope,
    @Query('device_id') deviceId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ingest.recent(scope, deviceId || undefined, limit ? Number(limit) : 300);
  }
}
