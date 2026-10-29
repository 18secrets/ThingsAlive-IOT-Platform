import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDefined, IsIn, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Matches } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ZoneAppliesTo } from './entities/geofence-zone.entity';
import { FleetStatusService } from './fleet-status.service';
import { GeofenceTracker } from './geofence-tracker.service';
import { GeofenceService } from './geofence.service';
import { ZoneKind } from './geometry';

const KINDS: ZoneKind[] = ['allowed', 'restricted', 'corridor'];
const TARGETS: ZoneAppliesTo[] = ['account', 'plant', 'equipment', 'equipment-class'];

export class ZoneDto {
  @IsString() @Matches(/^[A-Za-z0-9._-]+$/, { message: 'code is letters, digits and .-_ only' }) code: string;
  @IsString() @IsNotEmpty() name: string;
  @IsIn(KINDS) kind: ZoneKind;
  /** Polygon, Circle or Corridor. Its shape is checked by the database. */
  @IsDefined() @IsObject() shape: Record<string, unknown>;
  @IsIn(TARGETS) appliesTo: ZoneAppliesTo;
  @IsOptional() @IsString() plantId?: string;
  @IsOptional() @IsString() sourceSystem?: string;
  @IsOptional() @IsString() externalId?: string;
  @IsOptional() @IsString() equipmentClassSlug?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class ZonePatchDto {
  @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @IsOptional() @IsIn(KINDS) kind?: ZoneKind;
  @IsOptional() @IsObject() shape?: Record<string, unknown>;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class PositionDto {
  @IsNumber() lng: number;
  @IsNumber() lat: number;
}

/**
 * Geofence zones (task QGEO2, stage 1). Authoring takes `equipment.write`, as a site's
 * boundary does; reading and checking a position take `catalog.read`, as the machine list
 * does. Drawing is the UI's; this is the shape it sends.
 */
@ApiTags('Geofences')
@Controller()
export class GeofenceController {
  constructor(
    private readonly zones: GeofenceService,
    private readonly tracker: GeofenceTracker,
    private readonly fleet: FleetStatusService,
  ) {}

  @Get('geofences')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Geofence zones in this account' })
  list(
    @CurrentScope() scope: RequestScope,
    @Query('appliesTo') appliesTo?: ZoneAppliesTo,
    @Query('enabled') enabled?: string,
  ) {
    return this.zones.list(scope, {
      appliesTo: TARGETS.includes(appliesTo as ZoneAppliesTo) ? appliesTo : undefined,
      enabled: enabled === undefined ? undefined : enabled === 'true',
    });
  }

  // Before `geofences/:id`, which would otherwise take "fleet-status" for an id.
  @Get('geofences/fleet-status')
  @Requires('catalog.read')
  @ApiOperation({
    summary: 'Every machine\'s latest position against its zones and site boundary, for the fleet map; '
      + 'zone shapes included. Computed live from readings, not from visits',
  })
  fleetStatus(@CurrentScope() scope: RequestScope, @Query('siteId') siteId?: string) {
    if (siteId !== undefined && !/^[0-9a-f-]{36}$/i.test(siteId)) throw new BadRequestException('siteId is a uuid.');
    return this.fleet.status(scope, { plantId: siteId });
  }

  // Before `geofences/:id`, which would otherwise take "time-in-zone" for an id.
  @Get('geofences/time-in-zone')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Hours inside each zone per machine and local day, from visits; from/to required, at most 92 days' })
  timeInZone(
    @CurrentScope() scope: RequestScope,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('timezone') timezone?: string,
    @Query('sourceSystem') sourceSystem?: string,
    @Query('externalId') externalId?: string,
    @Query('zoneId') zoneId?: string,
  ) {
    const r = range(from, to);
    if (!r.from || !r.to) throw new BadRequestException('from and to are required.');
    if (zoneId !== undefined && !/^[0-9a-f-]{36}$/i.test(zoneId)) throw new BadRequestException('zoneId is a uuid.');
    return this.tracker.timeInZone(scope, { from: r.from, to: r.to, timezone, sourceSystem, externalId, zoneId });
  }

  @Get('geofences/:id')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'One geofence zone' })
  get(@CurrentScope() scope: RequestScope, @Param('id', ParseUUIDPipe) id: string) {
    return this.zones.get(scope, id);
  }

  @Post('geofences')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Add a zone: allowed, restricted or corridor; Polygon, Circle or Corridor' })
  create(@CurrentScope() scope: RequestScope, @Body() body: ZoneDto) {
    return this.zones.create(scope, body);
  }

  @Patch('geofences/:id')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Rename, reshape, change kind, or switch a zone on or off. Code and target never change' })
  update(@CurrentScope() scope: RequestScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: ZonePatchDto) {
    return this.zones.update(scope, id, body);
  }

  @Delete('geofences/:id')
  @Requires('equipment.write')
  @ApiOperation({ summary: 'Remove a zone' })
  remove(@CurrentScope() scope: RequestScope, @Param('id', ParseUUIDPipe) id: string) {
    return this.zones.remove(scope, id);
  }

  @Get('geofences/:id/visits')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Visits to this zone, newest first (at most 500); from/to bound the entry time' })
  zoneVisits(
    @CurrentScope() scope: RequestScope,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.tracker.visits(scope, { zoneId: id }, range(from, to));
  }

  @Get('equipment/:sourceSystem/:externalId/geofence-visits')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'This machine\'s zone visits, its site boundary\'s included, newest first (at most 500)' })
  machineVisits(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.tracker.visits(scope, { sourceSystem, externalId }, range(from, to));
  }

  @Get('equipment/:sourceSystem/:externalId/geofences')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Every zone that applies to this machine, its site boundary included' })
  forMachine(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.zones.zonesFor(scope, sourceSystem, externalId);
  }

  @Post('equipment/:sourceSystem/:externalId/geofences/check')
  @HttpCode(200)
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Inside or outside, and whether that breaks it, for each zone on this machine. Changes nothing' })
  check(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
    @Body() body: PositionDto,
  ) {
    return this.zones.check(scope, sourceSystem, externalId, [body.lng, body.lat]);
  }
}

/** An unreadable date is refused rather than ignored: ignoring it widens the answer silently. */
function range(from?: string, to?: string): { from?: Date; to?: Date } {
  const read = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`${name} is an ISO 8601 date or time.`);
    return d;
  };
  return { from: read(from, 'from'), to: read(to, 'to') };
}
