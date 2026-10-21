import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { MODEL_CONTENT_TYPES } from '../assets/asset-storage';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ModelBounds } from './visual/model-anchor-rules';
import { ClassModelService } from './services/class-model.service';
import { UploadUrlDto } from './class-visual.controller';

// Class DTOs, never interfaces: an interface gives the validation pipe nothing to check.

export class ConfirmModelDto {
  /** What the console measured, in model units — the API never sees the bytes. */
  @IsArray() @ArrayMinSize(3) @ArrayMaxSize(3) @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  boundsMin: number[];

  @IsArray() @ArrayMinSize(3) @ArrayMaxSize(3) @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  boundsMax: number[];

  /** Omitted means changed: keeping a geometry version is the claim that needs saying. */
  @IsOptional() @IsBoolean() geometryChanged?: boolean;
}

export class ModelAnchorDto {
  @IsString() @IsNotEmpty() signal: string;
  @IsNumber({ allowNaN: false, allowInfinity: false }) x: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) y: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) z: number;
  @IsOptional() @IsString() label?: string | null;
}

export class ModelAnchorSetDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ModelAnchorDto) anchors: ModelAnchorDto[];
}

export const toBounds = (dto: ConfirmModelDto): ModelBounds => ({
  min: dto.boundsMin as [number, number, number], max: dto.boundsMax as [number, number, number],
});

/**
 * The class's 3-D model for library authoring (task QTWIN1 §2), beside the schematic's
 * routes and on the same rules. `catalog.write` throughout.
 */
@ApiTags('Class visuals')
@Controller('platform/catalog/equipment-classes/:slug/:version/model')
export class ClassModelController {
  constructor(private readonly models: ClassModelService) {}

  @Post('upload-url')
  @Requires('catalog.write')
  @ApiOperation({ summary: `A short-lived URL to PUT the model to directly (${MODEL_CONTENT_TYPES.join(', ')})` })
  uploadUrl(
    @CurrentScope() scope: RequestScope, @Param('slug') slug: string,
    @Param('version', ParseIntPipe) version: number, @Body() dto: UploadUrlDto,
  ) {
    return this.models.issueUploadUrl(scope, slug, version, dto.contentType);
  }

  @Post('confirm')
  @HttpCode(200)
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Record the uploaded model and its bounding box once the object is confirmed to exist' })
  confirm(
    @CurrentScope() scope: RequestScope, @Param('slug') slug: string,
    @Param('version', ParseIntPipe) version: number, @Body() dto: ConfirmModelDto,
  ) {
    return this.models.confirm(scope, slug, version, toBounds(dto), dto.geometryChanged ?? true);
  }

  @Get()
  @Requires('catalog.write')
  @ApiOperation({ summary: 'The model, its geometry version and bounds, its anchors and the signals not yet placed' })
  read(@Param('slug') slug: string, @Param('version', ParseIntPipe) version: number) {
    return this.models.read(slug, version);
  }

  @Delete()
  @HttpCode(204)
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Remove the model and its anchors from a draft. The stored object is kept' })
  async remove(@CurrentScope() scope: RequestScope, @Param('slug') slug: string, @Param('version', ParseIntPipe) version: number) {
    await this.models.remove(scope, slug, version);
  }

  @Put('anchors')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Replace the whole model anchor set, validated as a set and against the model\'s bounds' })
  replaceAnchors(
    @CurrentScope() scope: RequestScope, @Param('slug') slug: string,
    @Param('version', ParseIntPipe) version: number, @Body() dto: ModelAnchorSetDto,
  ) {
    return this.models.replaceAnchors(scope, slug, version, dto.anchors.map((a) => ({ ...a, label: a.label ?? null })));
  }
}
