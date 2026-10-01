import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray, IsNotEmpty, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { NamedFormulaService } from './services/named-formula.service';

export class RoleInputDto {
  @IsString() @IsNotEmpty() role: string;
  @IsString() @IsNotEmpty() dimension: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) expectedParameters?: string[];
}

export class NamedFormulaDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() expression?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RoleInputDto)
  inputs?: RoleInputDto[];
  @IsOptional() @IsString() resultDimension?: string;
  @IsOptional() @IsString() resultKind?: any;
}

export class CreateNamedFormulaDto extends NamedFormulaDto {
  @IsString() @IsNotEmpty() slug: string;
}

/**
 * The named formula catalogue, over HTTP (task QCE3). `catalog.write` loads
 * content, `catalog.publish` publishes it — the same split QPA2 already
 * established for the rest of catalog authoring; accepting a formula into the
 * platform library is the same category of act as accepting one into a class.
 */
@ApiTags('Named Formulas')
@Controller('platform/catalog')
export class NamedFormulaController {
  constructor(private readonly namedFormulas: NamedFormulaService) {}

  @Get('named-formulas')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'List named formulas, filterable by status and category — what the binding picker reads' })
  list(@Query('status') status?: string, @Query('category') category?: string) {
    return this.namedFormulas.list(status, category);
  }

  @Get('named-formulas/:slug')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Every version of one named formula' })
  versions(@Param('slug') slug: string) {
    return this.namedFormulas.allVersions(slug);
  }

  @Post('named-formulas')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Create a named formula as a draft' })
  create(@CurrentScope() scope: RequestScope, @Body() dto: CreateNamedFormulaDto) {
    return this.namedFormulas.create(scope, dto.slug, dto as any);
  }

  @Patch('named-formulas/:slug/:version')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Edit a draft version. Refused once that version is published' })
  edit(
    @CurrentScope() scope: RequestScope,
    @Param('slug') slug: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: NamedFormulaDto,
  ) {
    return this.namedFormulas.edit(scope, slug, version, dto as any);
  }

  @Post('named-formulas/:slug/:version/publish')
  @Requires('catalog.publish')
  @ApiOperation({ summary: 'Compile and publish. Immutable from this point on' })
  publish(
    @CurrentScope() scope: RequestScope,
    @Param('slug') slug: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.namedFormulas.publish(scope, slug, version);
  }
}
