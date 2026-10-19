import { Controller, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Requires } from '../auth/guards/capability.guard';
import { LegacyFleetSyncService } from './legacy-fleet-sync.service';

/** Running the 1.0 fleet sync by hand (task QSYNC1). Things Alive only, like the archive run. */
@ApiTags('Legacy sync')
@Controller('platform/legacy-fleet-sync')
export class LegacyFleetSyncController {
  constructor(private readonly sync: LegacyFleetSyncService) {}

  @Post('run')
  @HttpCode(200)
  @Requires('platform.admin')
  @ApiOperation({ summary: 'Mirror 1.0\'s machines, loggers and sensor map now. Reads 1.0 only; a full reconcile of the mirror' })
  run(@Query('allowEmpty') allowEmpty?: string) {
    return this.sync.run({ allowEmpty: allowEmpty === 'true' });
  }
}
