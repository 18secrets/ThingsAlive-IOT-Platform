import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { SignalBindingOrigin } from './entities/signal-binding-version.entity';
import { SignalBindingService } from './services/signal-binding.service';

export class ProposeOrActivateBindingDto {
  @IsIn(['propose', 'activate'])
  action: 'propose' | 'activate';

  @IsString() @IsNotEmpty() signalKey: string;
  @IsString() @IsNotEmpty() measurementRole: string;
  @IsOptional() @IsString() componentId?: string;

  @IsIn(['physical', 'ecu_derived', 'virtual'])
  origin: SignalBindingOrigin;

  @IsOptional() @IsString() imei?: string;
  @IsOptional() @IsString() channel?: string;
  @IsOptional() @IsString() sensorInstanceId?: string;

  @IsString() @IsNotEmpty() canonicalUnit: string;
  @IsOptional() @IsString() sourceUnit?: string;

  @IsISO8601() validFrom: string;
  @IsOptional() @IsISO8601() validTo?: string;

  @IsOptional() @IsIn(['tool-mapping', 'sensor-map', 'both', 'manual', 'model'])
  discoveredBy?: 'tool-mapping' | 'sensor-map' | 'both' | 'manual' | 'model';
  @IsOptional() @IsString() discoveredFrom?: string;
}

/**
 * Coverage, discovery and resolve-at-event-time, over HTTP (task Q08S slice 2).
 *
 * Capabilities reused rather than invented, matching `EquipmentController`'s own
 * split for this exact `equipment/...` path: reads behind `catalog.read`, writes
 * behind `equipment.write`. Every route is tenant-scoped by `scope.tenantId` —
 * `resolveBinding` on the service takes a tenant explicitly because it also serves
 * internal callers (scoring, physics) with no request behind them, but every route
 * here only ever supplies the caller's own.
 */
@ApiTags('Signal Bindings')
@Controller('equipment')
export class SignalBindingController {
  constructor(private readonly bindings: SignalBindingService) {}

  @Get(':sourceSystem/:externalId/coverage')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Required signals against active bindings, at one instant' })
  coverage(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('at') at?: string,
  ) {
    return this.bindings.coverage(scope, { sourceSystem, externalId }, at ? new Date(at) : new Date());
  }

  @Get(':sourceSystem/:externalId/binding-discovery')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'tool_mapping vs. sensor_map: matched, expected-not-mapped, mapped-not-expected' })
  discover(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.bindings.discover(scope, { sourceSystem, externalId });
  }

  @Post(':sourceSystem/:externalId/bindings')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Propose a candidate binding, or activate one as the confirmed primary' })
  proposeOrActivate(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Body() body: ProposeOrActivateBindingDto,
  ) {
    const input = {
      signalKey: body.signalKey, measurementRole: body.measurementRole, componentId: body.componentId,
      origin: body.origin, imei: body.imei, channel: body.channel, sensorInstanceId: body.sensorInstanceId,
      canonicalUnit: body.canonicalUnit, sourceUnit: body.sourceUnit,
      validFrom: new Date(body.validFrom), validTo: body.validTo ? new Date(body.validTo) : null,
      discoveredBy: body.discoveredBy, discoveredFrom: body.discoveredFrom,
    };
    const equipment = { sourceSystem, externalId };
    return body.action === 'activate'
      ? this.bindings.activate(scope, equipment, input)
      : this.bindings.propose(scope, equipment, input);
  }
}
