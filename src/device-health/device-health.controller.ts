import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { DeviceHealthService } from './services/device-health.service';
import { LinkState } from './services/link-health';

const STATES: LinkState[] = [
  'dark', 'partial', 'intermittent', 'buffering', 'weak-signal', 'healthy', 'unknown',
];

/**
 * Which loggers are in trouble, and what kind (task P4-08).
 *
 * Behind `device.read`, which every role inside the tenant holds: "which of our loggers
 * is off the air" is not a privileged question about your own kit. An operator sees the
 * devices on the machines assigned to them, narrowed by the assignment list rather than
 * by the capability, as everywhere else.
 */
@ApiTags('Device health')
@Controller('device-health')
export class DeviceHealthController {
  constructor(private readonly health: DeviceHealthService) {}

  @Get()
  @Requires('device.read')
  @ApiOperation({ summary: 'The newest verdict per logger, worst first, with how long it has stood' })
  fleet(
    @CurrentScope() scope: RequestScope,
    @Query('state') state?: string,
    @Query('days') days?: string,
  ) {
    const states = state
      ? state.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const unknown = states?.filter((s) => !STATES.includes(s as LinkState)) ?? [];
    if (unknown.length) {
      throw new BadRequestException(
        `Unknown state(s) ${unknown.join(', ')}. Expected one of: ${STATES.join(', ')}.`,
      );
    }

    let sinceDays: number | undefined;
    if (days !== undefined && days !== '') {
      sinceDays = Number(days);
      // A non-numeric `days` would become NaN, and a NaN date matches nothing — an
      // empty fleet that looks exactly like a fleet with no loggers.
      if (!Number.isFinite(sinceDays) || sinceDays <= 0) {
        throw new BadRequestException(`days must be a positive number; got "${days}".`);
      }
    }

    return this.health.fleet(scope, { states: states as LinkState[] | undefined, sinceDays });
  }

  @Get(':imei')
  @Requires('device.read')
  @ApiOperation({ summary: 'Window by window for one logger, newest first' })
  forDevice(@CurrentScope() scope: RequestScope, @Param('imei') imei: string) {
    return this.health.forDevice(scope, imei);
  }
}
