import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
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

/**
 * Creating a template sends its slug in the body; editing one names it in the path.
 *
 * The create routes used to read that slug with a second `@Body('slug')` parameter
 * beside a DTO that never declared it — and a pipe set to whitelist +
 * forbidNonWhitelisted strips an undeclared property and then refuses the request for
 * carrying it. Both routes answered 400 to every correct call. Declaring the property
 * is what makes the body legal; reading it off the DTO is what stops the two halves
 * from drifting apart again.
 */
export class CreateTemplateClassDto extends TemplateClassDto {
  @IsString() @IsNotEmpty() slug: string;
}

export class CreateTemplateScenarioDto extends TemplateScenarioDto {
  @IsString() @IsNotEmpty() slug: string;
}

export class AlertTemplateDto {
  @IsOptional() @IsString() equipmentClassSlug?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() trigger?: any;
  @IsOptional() params?: any;
  @IsOptional() @IsString() severity?: any;
  @IsOptional() @IsBoolean() enabledOnCopy?: boolean;
}

export class CreateAlertTemplateDto extends AlertTemplateDto {
  @IsString() @IsNotEmpty() slug: string;
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
    @Body() dto: CreateTemplateClassDto,
  ) {
    return this.authoring.createClass(scope, dto.slug, dto);
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
    @Body() dto: CreateTemplateScenarioDto,
  ) {
    return this.authoring.createScenario(scope, dto.slug, dto);
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

  // ---- What the authoring console reads (task P1-133) ---------------------------
  //
  // `GET /catalog/equipment-classes` returns published classes only, and correctly: a
  // tenant that could see a draft could activate something Things Alive has not
  // finished writing. But the authoring screen is the one place drafts must be
  // visible, and until now nothing could list them — a draft could be created and
  // then never found again except by knowing its slug.
  //
  // A separate route rather than a flag on the existing one. A `?includeDrafts=true`
  // that a client could also send is one forgotten capability check away from being
  // the leak the published-only rule exists to prevent.

  @Get('authoring/equipment-classes')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Every class version, draft and published — Things Alive only' })
  authoringClasses() {
    return this.authoring.allClasses();
  }

  @Get('authoring/scenarios')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Every scenario version, draft and published' })
  authoringScenarios(@Query('equipmentClassSlug') classSlug?: string) {
    return this.authoring.allScenarios(classSlug);
  }

  @Get('authoring/alert-templates')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Every alert-rule template version, draft and published' })
  authoringAlertTemplates(@Query('equipmentClassSlug') classSlug?: string) {
    return this.authoring.allAlertTemplates(classSlug);
  }

  @Get('authoring/signal-aliases')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Every signal alias' })
  authoringAliases() {
    return this.authoring.allAliases();
  }

  // ---- Alert rule templates (task P1-128) ---------------------------------------
  //
  // What Things Alive knows is worth being told about, for a kind of machine. Granting
  // the class copies these into the account as the client's own rules, which they then
  // edit and Things Alive cannot.

  @Post('alert-templates')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Create an alert-rule template as a draft' })
  createAlertTemplate(
    @CurrentScope() scope: RequestScope,
    @Body() dto: CreateAlertTemplateDto,
  ) {
    return this.authoring.createAlertTemplate(scope, dto.slug, dto);
  }

  @Patch('alert-templates/:slug')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Edit the draft, forking one from the published version if needed' })
  editAlertTemplate(
    @CurrentScope() scope: RequestScope,
    @Param('slug') slug: string,
    @Body() dto: AlertTemplateDto,
  ) {
    return this.authoring.editAlertTemplate(scope, slug, dto);
  }

  @Post('alert-templates/:slug/publish')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Publish it. Accounts granted the class from now on get a copy' })
  publishAlertTemplate(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.authoring.publishAlertTemplate(scope, slug);
  }

  @Post('alert-templates/:slug/retire')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Stop shipping it. Copies already in accounts keep running' })
  retireAlertTemplate(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.authoring.retireAlertTemplate(scope, slug);
  }

  @Post('entitlements/:id/revoke')
  @Requires('entitlement.grant')
  @ApiOperation({ summary: 'Revoke a grant. The row stays; revoked is not deleted' })
  revoke(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.entitlements.revoke(scope, id);
  }
}
