import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { VisibleTo } from '../common/field-policy';
import { CatalogService } from './services/catalog.service';
import { EntitlementService } from './services/entitlement.service';
import { RecommendationService } from './services/recommendation.service';

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

  @Post('entitlements/:id/revoke')
  @Requires('entitlement.grant')
  @ApiOperation({ summary: 'Revoke a grant. The row stays; revoked is not deleted' })
  revoke(@CurrentScope() scope: RequestScope, @Param('id') id: string) {
    return this.entitlements.revoke(scope, id);
  }
}
