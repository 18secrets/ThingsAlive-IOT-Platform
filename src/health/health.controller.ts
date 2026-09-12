import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';

/**
 * Liveness and readiness are different questions and Railway needs the second one.
 * /health says the process is up. /ready says it can actually serve — once the
 * database, Redis and the broker are wired, each becomes a check here, and the
 * deployment holds the previous version until this passes.
 */
@ApiTags('Health')
@Controller()
export class HealthController {
  @Public('liveness probe — must answer before dependencies are wired')
  @Get('health')
  @ApiOperation({ summary: 'Liveness: the process is running' })
  health() {
    return { status: 'ok', service: 'ta-platform-2', time: new Date().toISOString() };
  }

  @Public('readiness probe — read by the platform healthcheck')
  @Get('ready')
  @ApiOperation({ summary: 'Readiness: dependencies reachable' })
  ready() {
    // Dependency checks are added here as each is introduced (P1-35 onward).
    const checks: Record<string, 'ok' | 'not_configured'> = {
      config: 'ok',
      database: 'not_configured',
      broker: 'not_configured',
    };
    return { status: 'ok', checks, time: new Date().toISOString() };
  }
}
