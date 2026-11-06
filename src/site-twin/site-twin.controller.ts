import { Body, Controller, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsDefined, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { PageService } from '../page/page.service';
import { ZONE_KINDS, ZoneKind } from './site-twin.entity';
import { SiteTwinService } from './site-twin.service';

// The bounds here are shape only. Whether a zone or machine fits inside the site is the
// database's rule (`ck_site_twin_fits`), so it holds for writers that skip this DTO.
export class SiteExtentDto {
  @IsNumber() @Min(10) @Max(5000) widthM: number;
  @IsNumber() @Min(10) @Max(5000) depthM: number;
}

const ZONE_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class SiteZoneDto {
  @Matches(ZONE_KEY, { message: 'key is lower-case letters, digits and dashes, up to 40.' }) key: string;
  @IsString() @IsNotEmpty() @MaxLength(60) label: string;
  @IsIn(ZONE_KINDS) kind: ZoneKind;
  @IsNumber() x: number;
  @IsNumber() z: number;
  @IsNumber() @Min(1) widthM: number;
  @IsNumber() @Min(1) depthM: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(80) floors?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0) @Max(100) progressPct?: number | null;
}

export class SitePlacementDto {
  @IsString() @IsNotEmpty() sourceSystem: string;
  @IsString() @IsNotEmpty() externalId: string;
  @IsNumber() x: number;
  @IsNumber() z: number;
  @IsNumber() headingDeg: number;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @Matches(ZONE_KEY, { each: true }) route?: string[];
}

export class ZoneProgressDto {
  @IsNumber() @Min(0) @Max(100) progressPct: number;
}

/** The editor's draft as auto-arrange receives it: the zones to keep, on the site as sized. */
export class SiteDraftDto {
  @IsDefined() @ValidateNested() @Type(() => SiteExtentDto) extent: SiteExtentDto;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SiteZoneDto) zones: SiteZoneDto[];
}

export class SiteLayoutDto {
  @IsInt() @Min(0) expectedVersion: number;
  @ValidateNested() @Type(() => SiteExtentDto) extent: SiteExtentDto;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SiteZoneDto) zones: SiteZoneDto[];
  @IsArray() @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => SitePlacementDto) placements: SitePlacementDto[];
}

/**
 * Saving a site's twin layout. Reading it is `GET /sites/:plantId/twin`, a composed page
 * (`page.controller.ts`), because it carries live status the layout alone does not own.
 *
 * Not idempotent: a save names the version it was drawn on and bumps it, so replaying
 * the same body is a 409. That is the point — the replay is indistinguishable from a
 * second person's stale save.
 */
@ApiTags('Site twin')
@Controller()
export class SiteTwinController {
  constructor(
    private readonly twins: SiteTwinService,
    private readonly pages: PageService,
  ) {}

  @Put('sites/:plantId/twin/layout')
  @Requires('equipment.write')
  @ApiOperation({ summary: "Replace a site's twin layout: extent, zones and machine placements. 409 if expectedVersion is stale." })
  async save(
    @CurrentScope() scope: RequestScope,
    @Param('plantId', ParseUUIDPipe) plantId: string,
    @Body() body: SiteLayoutDto,
  ) {
    await this.twins.save(scope, plantId, body);
    return this.pages.siteTwin(scope, plantId);
  }

  @Put('sites/:plantId/twin/zones/:zoneKey/progress')
  @Requires('equipment.write')
  @ApiOperation({ summary: "Report how far one structure (building, road, substation, quay) has got, 0-100, dated now" })
  async progress(
    @CurrentScope() scope: RequestScope,
    @Param('plantId', ParseUUIDPipe) plantId: string,
    @Param('zoneKey') zoneKey: string,
    @Body() body: ZoneProgressDto,
  ) {
    await this.twins.reportProgress(scope, plantId, zoneKey, body.progressPct);
    return this.pages.siteTwin(scope, plantId);
  }
}
