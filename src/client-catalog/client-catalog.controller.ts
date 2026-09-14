import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min,
} from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { Severity } from '../common/severity';
import { ClientCatalogService } from './services/client-catalog.service';

export class EditClassDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsArray() expectedSignals?: any[];
  @IsOptional() @IsArray() failureModes?: any[];
  @IsOptional() defaultThresholds?: Record<string, unknown>;
}

export class EditScenarioDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsIn(Object.values(Severity)) severity?: Severity;
  @IsOptional() @IsInt() @Min(1) @Max(3) tier?: 1 | 2 | 3;
  @IsOptional() @IsArray() @IsString({ each: true }) requiredSignals?: string[];
  @IsOptional() @IsInt() @Min(0) @Max(365) minimumHistoryDays?: number;
  @IsOptional() @IsArray() parameters?: any[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

/**
 * The client's own catalog (task P1-21's catalog half).
 *
 * Separate from `/catalog`, which serves Things Alive's templates, because they are
 * different things with different owners. Everything here is scoped to the caller's
 * tenant by the session it runs in; reads are open to every role inside the account
 * and writes are super admin alone.
 *
 * There is no route by which a Things Alive role writes here. `client-catalog.write`
 * lists no platform role, and the service beneath has no cross-tenant method to call.
 */
@ApiTags('Client catalog')
@Controller('my-catalog')
export class ClientCatalogController {
  constructor(private readonly clientCatalog: ClientCatalogService) {}

  @Get('equipment-classes')
  @Requires('client-catalog.read')
  @ApiOperation({ summary: "This account's equipment classes, with where each came from" })
  classes(@CurrentScope() scope: RequestScope) {
    return this.clientCatalog.classes(scope);
  }

  @Get('equipment-classes/:slug')
  @Requires('client-catalog.read')
  oneClass(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.clientCatalog.oneClass(scope, slug);
  }

  @Patch('equipment-classes/:slug')
  @Requires('client-catalog.write')
  @ApiOperation({ summary: 'Edit this account\'s copy. Super admin only' })
  editClass(
    @CurrentScope() scope: RequestScope,
    @Param('slug') slug: string,
    @Body() dto: EditClassDto,
  ) {
    return this.clientCatalog.editClass(scope, slug, dto);
  }

  @Get('scenarios')
  @Requires('client-catalog.read')
  scenarios(@CurrentScope() scope: RequestScope, @Query('class') classSlug?: string) {
    return this.clientCatalog.scenarios(scope, classSlug);
  }

  @Get('scenarios/:slug')
  @Requires('client-catalog.read')
  @ApiOperation({ summary: 'One scenario, and whether it still matches the template it came from' })
  oneScenario(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.clientCatalog.oneScenario(scope, slug);
  }

  @Patch('scenarios/:slug')
  @Requires('client-catalog.write')
  @ApiOperation({ summary: 'Edit thresholds, signals, severity or switch it off. Super admin only' })
  editScenario(
    @CurrentScope() scope: RequestScope,
    @Param('slug') slug: string,
    @Body() dto: EditScenarioDto,
  ) {
    return this.clientCatalog.editScenario(scope, slug, dto);
  }

  @Post('scenarios/:slug/adopt-latest-template')
  @Requires('client-catalog.write')
  @ApiOperation({
    summary: 'Replace this copy with the latest published template, discarding local edits',
  })
  adopt(@CurrentScope() scope: RequestScope, @Param('slug') slug: string) {
    return this.clientCatalog.adoptLatestTemplate(scope, slug);
  }
}
