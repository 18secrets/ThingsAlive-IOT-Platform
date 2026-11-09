import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { MotorAck, MotorIngestService } from './motor-ingest.service';

/**
 * The paths the motor logger firmware already calls, unversioned: `/api/sensor-data/bulk`
 * rather than `/api/v1/...`. Firmware on a SIM800L in the field is not updated on our
 * release schedule, so the device's URL is the contract and the route fits it.
 */
@ApiTags('Motor loggers')
@Controller({ version: VERSION_NEUTRAL })
export class MotorIngestController {
  constructor(private readonly ingest: MotorIngestService) {}

  /**
   * 200, not Nest's default 201 for a POST: the contract's ACK is a 200, and a device
   * parser written against it should not have to know better.
   */
  @Post('sensor-data/bulk')
  @HttpCode(200)
  @Public('A motor logger has no user session; it proves itself with X-Device-Key, checked in the service.')
  @ApiOperation({ summary: 'Motor logger bulk upload: ≤ 50 records, ACKed only after they are committed' })
  bulk(
    @Body() body: unknown,
    @Headers('x-device-key') key?: string,
    @Headers('content-length') contentLength?: string,
  ): Promise<MotorAck> {
    return this.ingest.bulk(body, key, contentLength ? Number(contentLength) : undefined);
  }

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

/** Issuing a logger's key: Master Admin, versioned like every other console route. */
@ApiTags('Motor loggers')
@Controller('motor-loggers')
export class MotorLoggerKeyController {
  constructor(private readonly ingest: MotorIngestService) {}

  @Post(':deviceId/key')
  @Requires('device.manage')
  @ApiOperation({ summary: 'Issue (or replace) a motor logger\'s X-Device-Key. Shown once; only its hash is kept' })
  issueKey(@CurrentScope() scope: RequestScope, @Param('deviceId') deviceId: string) {
    return this.ingest.issueKey(scope, deviceId);
  }
}
