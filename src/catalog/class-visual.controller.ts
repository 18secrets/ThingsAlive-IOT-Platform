import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min, ValidateNested,
} from 'class-validator';
import { VISUAL_CONTENT_TYPES } from '../assets/asset-storage';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { ClassVisualService } from './services/class-visual.service';

// Class DTOs, never interfaces: an interface gives the validation pipe nothing to
// check, so a malformed body reaches the service (QFIX-SENSORS).

export class UploadUrlDto {
  // Checked again in the service so the refusal names the type; here so an unknown
  // field or a missing one is a 400 before anything runs.
  @IsString() @IsNotEmpty() contentType: string;
}

export class ConfirmUploadDto {
  /** What the console measured — the API never sees the bytes. */
  @IsInt() @Min(1) width: number;
  @IsInt() @Min(1) height: number;
}

export class AnchorDto {
  @IsString() @IsNotEmpty() signal: string;
  @IsNumber() @Min(0) @Max(100) hotspotX: number;
  @IsNumber() @Min(0) @Max(100) hotspotY: number;
  @IsOptional() @IsString() label?: string | null;
}

export class AnchorSetDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => AnchorDto) anchors: AnchorDto[];
}

/**
 * Class visuals for library authoring (task QREC0c §3). `catalog.write` throughout;
 * publishing the class stays `catalog.publish`, on the class's own route.
 */
@ApiTags('Class visuals')
@Controller('platform/catalog/equipment-classes/:slug/:version')
export class ClassVisualController {
  constructor(private readonly visuals: ClassVisualService) {}

  @Post('visual/upload-url')
  @Requires('catalog.write')
  @ApiOperation({ summary: `A short-lived URL to PUT the image to directly (${VISUAL_CONTENT_TYPES.join(', ')})` })
  uploadUrl(
    @CurrentScope() scope: RequestScope, @Param('slug') slug: string,
    @Param('version', ParseIntPipe) version: number, @Body() dto: UploadUrlDto,
  ) {
    return this.visuals.issueUploadUrl(scope, slug, version, dto.contentType);
  }

  @Post('visual/confirm')
  @HttpCode(200)
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Record the uploaded image once the object is confirmed to exist' })
  confirm(
    @CurrentScope() scope: RequestScope, @Param('slug') slug: string,
    @Param('version', ParseIntPipe) version: number, @Body() dto: ConfirmUploadDto,
  ) {
    return this.visuals.confirm(scope, slug, version, dto.width, dto.height);
  }

  @Get('visual')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'The visual, its anchors and the signals not yet placed' })
  read(@Param('slug') slug: string, @Param('version', ParseIntPipe) version: number) {
    return this.visuals.read(slug, version);
  }

  @Delete('visual')
  @HttpCode(204)
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Remove the visual and its anchors from a draft. The stored object is kept' })
  async remove(@CurrentScope() scope: RequestScope, @Param('slug') slug: string, @Param('version', ParseIntPipe) version: number) {
    await this.visuals.remove(scope, slug, version);
  }

  @Put('anchors')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Replace the whole anchor set, validated as a set' })
  replaceAnchors(
    @CurrentScope() scope: RequestScope, @Param('slug') slug: string,
    @Param('version', ParseIntPipe) version: number, @Body() dto: AnchorSetDto,
  ) {
    return this.visuals.replaceAnchors(scope, slug, version, dto.anchors.map((a) => ({ ...a, label: a.label ?? null })));
  }
}
