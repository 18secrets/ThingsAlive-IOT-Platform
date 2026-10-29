import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDefined, IsIn, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Matches } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ZoneAppliesTo } from './entities/geofence-zone.entity';
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
  constructor(private readonly zones: GeofenceService) {}

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
