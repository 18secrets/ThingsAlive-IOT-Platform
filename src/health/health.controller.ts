import { Controller, Get, Optional, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator';
import { LegacyTelemetryReader } from '../legacy/legacy-telemetry.reader';
import { probe, ReadinessChecks, STATUS_CODE, summarise } from './readiness';

/**
 * Liveness and readiness are different questions and Railway needs the second one.
 * /health says the process is up. /ready says it can actually serve, and the
 * deployment holds the previous version until it answers 200 (task D-04).
 *
 * Both dependencies are injected optionally because this controller is registered
 * whether or not the application was built with a database — specs boot it without
 * one, and a readiness endpoint that cannot start is not a readiness endpoint.
 */
@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(
    @Optional() private readonly ds?: DataSource,
    // The reader, not the connection. The connection to the existing platform belongs
    // to one module and is injected nowhere else — a second holder is how the
    // read-only guarantee quietly becomes a convention, and wiring.spec fails on it.
    @Optional() private readonly legacy?: LegacyTelemetryReader,
  ) {}

  @Public('liveness probe — must answer before dependencies are wired')
  @Get('health')
  @ApiOperation({ summary: 'Liveness: the process is running' })
  health() {
    return { status: 'ok', service: 'ta-platform-2', time: new Date().toISOString() };
  }

  @Public('readiness probe — read by the platform healthcheck')
  @Get('ready')
  @ApiOperation({ summary: 'Readiness: dependencies actually answered' })
  @ApiResponse({ status: 200, description: 'Ready, or degraded but able to serve' })
  @ApiResponse({ status: 503, description: 'A required dependency did not answer' })
  async ready(@Res({ passthrough: true }) res: { status: (code: number) => unknown }) {
    const [database, legacy] = await Promise.all([
      probe(this.ds),
      this.legacy?.probeConnection() ?? Promise.resolve('not_configured' as const),
    ]);
    const checks: ReadinessChecks = { database, legacy };
    const status = summarise(checks);

    // The same body either way. Whoever opens this URL at 3am wants to see which
    // dependency is down, not an error envelope explaining that something is.
    res.status(STATUS_CODE[status]);
    return { status, checks, time: new Date().toISOString() };
  }
}
