import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { VisibleTo } from '../common/field-policy';
import { CatalogAuthoringService } from './services/catalog-authoring.service';
import { CatalogService } from './services/catalog.service';
import { EntitlementService } from './services/entitlement.service';
import { RecommendationService } from './services/recommendation.service';

export class TemplateClassDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() expectedSignals?: any[];
  @IsOptional() failureModes?: any[];
  @IsOptional() defaultThresholds?: Record<string, unknown>;
}

export class TemplateScenarioDto {
  @IsOptional() @IsString() equipmentClassSlug?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() severity?: any;
  @IsOptional() tier?: any;
  @IsOptional() requiredSignals?: string[];
  @IsOptional() minimumHistoryDays?: number;
  @IsOptional() parameters?: any[];
}

export class AliasDto {
  @IsString() @IsNotEmpty() sourceSystem: string;
  @IsString() @IsNotEmpty() alias: string;
  @IsString() @IsNotEmpty() canonical: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsString() note?: string;
}

export class GrantEntitlementDto {
  @IsString() @IsNotEmpty()
  tenantId: string;

  @IsString() @IsNotEmpty()
  equipmentClassSlug: string;

  @IsOptional() @IsString()
  note?: string;
}

/**
 * The catalog as one caller is entitled to see it (tasks P1-01, P1-04, P1-10).
 *
 * Reads are narrowed by the entitlement join rather than by role — every role inside
 * a tenant sees the same classes, because what a tenant bought is not a question
 * about who is logged in.
 */
@ApiTags('Catalog')
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly authoring: CatalogAuthoringService,
    private readonly entitlements: EntitlementService,
    private readonly recommendations: RecommendationService,
  ) {}

  @Get('equipment-classes')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Equipment classes this tenant is entitled to' })
  // defaultThresholds carry OEM limits that are commercially sensitive to Things
  // Alive's suppliers; the operator screens do not use them.
  @VisibleTo({ defaultThresholds: ['super admin', 'admin', 'master-admin', 'catalog-author'] })
  classes(@CurrentScope() scope: RequestScope) {
    return this.catalog.equipmentClasses(scope);
  }

  @Get('equipment-classes/:slug')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'One equipment class. 404 when not entitled, never 403' })
  @VisibleTo({ defaultThresholds: ['super admin', 'admin', 'master-admin', 'catalog-author'] })
  oneClass(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.catalog.equipmentClass(scope, slug);
  }

  @Get('equipment-classes/:slug/scenarios')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Published scenarios for a class, latest version of each' })
  classScenarios(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.catalog.scenariosForClass(scope, slug);
  }

  @Get('scenarios')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Every scenario across the entitled classes' })
  scenarios(@CurrentScope() scope: RequestScope) {
    return this.catalog.scenarios(scope);
  }

  @Get('equipment/:sourceSystem/:externalId/recommendations')
  @Requires('catalog.read')
  @ApiOperation({ summary: 'Which scenarios this asset can run, and what blocks the rest' })
  forEquipment(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('externalId') externalId: string,
  ) {
    return this.recommendations.forEquipment(scope, sourceSystem, externalId);
  }

  @Get('entitlements')
  @Requires('entitlement.grant')
  @ApiOperation({ summary: 'Grants across tenants — master admin only' })
  listGrants(@CurrentScope() scope: RequestScope) {
    return this.entitlements.list(scope);
  }

  @Post('entitlements')
  @Requires('entitlement.grant')
  @ApiOperation({ summary: 'Grant a class to a tenant' })
  grant(@CurrentScope() scope: RequestScope, @Body() dto: GrantEntitlementDto) {
    return this.entitlements.grant(scope, dto.tenantId, dto.equipmentClassSlug, dto.note);
  }

  // ---- Template authoring. Things Alive only, and templates only. -------------
  //
  // Every route below writes a template. None of them can reach a client's copy: the
  // service behind them holds no repository for those tables, so "master admin
  // cannot edit a client's settings" is a property of the wiring rather than a rule
  // somebody has to remember to check.

  @Post('equipment-classes')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Create a template class as a draft' })
  createClass(
    @CurrentScope() scope: RequestScope,
    @Body('slug') slug: string,
    @Body() dto: TemplateClassDto,
  ) {
    return this.authoring.createClass(scope, slug, dto);
  }

  @Patch('equipment-classes/:slug')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Edit the draft, forking one from the published version if needed' })
  editClass(
    @CurrentScope() scope: RequestScope,
    @Param('slug') slug: string,
    @Body() dto: TemplateClassDto,
  ) {
    return this.authoring.editClass(scope, slug, dto);
  }

  @Post('equipment-classes/:slug/publish')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Publish the draft. Existing client copies are unaffected' })
  publishClass(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.authoring.publishClass(scope, slug);
  }

  @Post('equipment-classes/:slug/retire')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Stop offering it. Clients who have a copy keep running it' })
  retireClass(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.authoring.retireClass(scope, slug);
  }

  @Post('scenarios')
  @Requires('catalog.write')
  createScenario(
    @CurrentScope() scope: RequestScope,
    @Body('slug') slug: string,
    @Body() dto: TemplateScenarioDto,
  ) {
    return this.authoring.createScenario(scope, slug, dto);
  }

  @Patch('scenarios/:slug')
  @Requires('catalog.write')
  editScenario(
    @CurrentScope() scope: RequestScope,
    @Param('slug') slug: string,
    @Body() dto: TemplateScenarioDto,
  ) {
    return this.authoring.editScenario(scope, slug, dto);
  }

  @Post('scenarios/:slug/publish')
  @Requires('catalog.write')
  publishScenario(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.authoring.publishScenario(scope, slug);
  }

  @Post('signal-aliases')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Map an upstream spelling to a canonical signal name' })
  upsertAlias(@CurrentScope() scope: RequestScope, @Body() dto: AliasDto) {
    return this.authoring.upsertAlias(
      scope, dto.sourceSystem, dto.alias, dto.canonical, dto.unit ?? null, dto.note ?? null,
    );
  }

  @Delete('signal-aliases/:sourceSystem/:alias')
  @Requires('catalog.write')
  deleteAlias(
    @CurrentScope() scope: RequestScope,
    @Param('sourceSystem') sourceSystem: string,
    @Param('alias') alias: string,
  ) {
    return this.authoring.deleteAlias(scope, sourceSystem, alias);
  }

  @Post('entitlements/:id/revoke')
  @Requires('entitlement.grant')
  @ApiOperation({ summary: 'Revoke a grant. The row stays; revoked is not deleted' })
  revoke(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.entitlements.revoke(scope, id);
  }
}
