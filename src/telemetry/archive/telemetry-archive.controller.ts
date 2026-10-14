import { Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../../auth/decorators/current-scope.decorator';
import { Requires } from '../../auth/guards/capability.guard';
import { RequestScope } from '../../auth/types/request-scope';
import { TelemetryArchiveService } from './telemetry-archive.service';

/** Things Alive's view of the archive (task QARCH1). Customers read their own prefix
 * with credentials scoped to it, not through this API. */
@ApiTags('Platform')
@Controller('platform/telemetry-archives')
export class TelemetryArchiveController {
  constructor(private readonly archive: TelemetryArchiveService) {}

  @Get()
  @Requires('platform.admin')
  @ApiOperation({ summary: 'Every archive written and every partition dropped' })
  list(@CurrentScope() scope: RequestScope) {
    return this.archive.list(scope);
  }

  @Post('run')
  @Requires('platform.admin')
  @ApiOperation({ summary: 'Run the archive pass now: export, verify, then drop each month past 90 days' })
  run(@CurrentScope() scope: RequestScope) {
    if (!scope.isPlatformRole) throw new ForbiddenException('Only Things Alive can run the archive pass.');
    return this.archive.run();
  }
}
