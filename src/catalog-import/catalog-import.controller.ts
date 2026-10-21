import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post,
  StreamableFile, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { CatalogImportApplyService } from './services/catalog-import-apply.service';
import { CatalogImportDiffService } from './services/catalog-import-diff.service';
import { CatalogImportSensorReviewService, SensorReviewRequest } from './services/catalog-import-sensor-review.service';
import { CatalogImportValidatorService } from './services/catalog-import-validator.service';
import { CatalogTemplateService } from './services/catalog-template.service';
import { CatalogImportRefusal, WorkbookParserService } from './services/workbook-parser.service';

export class SlugRefDto {
  @IsString() @IsNotEmpty() slug: string;
}

/**
 * The sensor-review body as a class, not the service's interface (task QFIX-SENSORS).
 *
 * Typed as `SensorReviewRequest` — an interface, so `Object` at runtime — the global
 * ValidationPipe skipped this body entirely. Under Express 5 an empty POST, or one
 * without `Content-Type: application/json`, leaves `req.body` undefined rather than
 * `{}`, and that undefined reached the service and 500'd on a dereference. A class
 * gives the pipe something to check: an unknown field (a typo'd `approveCategory`)
 * is refused by `forbidNonWhitelisted` instead of silently doing nothing, and an entry
 * without a slug is refused naming the array and index (`approve.0.slug`).
 */
export class SensorReviewDto implements SensorReviewRequest {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SlugRefDto)
  approveCategories?: SlugRefDto[];

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SlugRefDto)
  approve?: SlugRefDto[];

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SlugRefDto)
  dismiss?: SlugRefDto[];
}

/**
 * The Excel catalog import, over HTTP (tasks QIMP2, QIMP3).
 *
 * `catalog.write` throughout — the same capability the rest of catalog authoring
 * already requires (`src/catalog/catalog.controller.ts`). Staging or applying a
 * workbook is authoring the library, not a new kind of action that needs its own
 * permission.
 */
@ApiTags('Catalog Import')
@Controller('platform/catalog')
export class CatalogImportController {
  constructor(
    private readonly parser: WorkbookParserService,
    private readonly validator: CatalogImportValidatorService,
    private readonly diff: CatalogImportDiffService,
    private readonly templates: CatalogTemplateService,
    private readonly applier: CatalogImportApplyService,
    private readonly sensorReview: CatalogImportSensorReviewService,
  ) {}

  @Post('imports')
  @Requires('catalog.write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Upload a workbook: parsed and validated in one step' })
  async upload(
    // Typed loosely rather than as Express.Multer.File: that type lives in
    // @types/multer, an extra dependency for the one field this route reads
    // (.buffer, .originalname) off of.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @UploadedFile() file: any,
    @CurrentScope() scope: RequestScope,
  ) {
    if (!file) throw new BadRequestException('A workbook file is required.');
    try {
      const parsed = await this.parser.parse(file.buffer, file.originalname, scope.userId);
      await this.validator.validate(parsed.id);
      return { id: parsed.id };
    } catch (err) {
      if (err instanceof CatalogImportRefusal) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Get('imports')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Recently uploaded batches' })
  recent() {
    return this.diff.list();
  }

  @Get('imports/:id')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'The dry-run diff for one batch: what would change if it were applied' })
  diffFor(@Param('id') id: string) {
    return this.diff.buildDiff(id);
  }

  @Delete('imports/:id')
  @Requires('catalog.write')
  @HttpCode(204)
  @ApiOperation({ summary: 'Discard a batch that has not been applied' })
  async discard(@Param('id') id: string): Promise<void> {
    await this.diff.discard(id);
  }

  @Post('imports/:id/apply')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Apply a validated batch: writes the catalog, versioned and provenanced' })
  apply(
    @Param('id') id: string,
    @CurrentScope() scope: RequestScope,
    @Body('acknowledgeWarnings') acknowledgeWarnings?: boolean,
  ) {
    return this.applier.apply(id, scope.userId, acknowledgeWarnings === true);
  }

  @Post('imports/:id/sensors')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Approve or dismiss the sensors and categories a batch proposes; re-validates and returns the diff' })
  reviewSensors(
    @Param('id') id: string,
    @CurrentScope() scope: RequestScope,
    @Body() body: SensorReviewDto,
  ) {
    // An approval call that decides nothing is a mistake, not a no-op — and it is
    // what a missing body arrives as once the pipe has turned it into `{}`.
    const decisions = (body?.approveCategories?.length ?? 0) + (body?.approve?.length ?? 0)
      + (body?.dismiss?.length ?? 0);
    if (!decisions) {
      throw new BadRequestException(
        'Name at least one of "approveCategories", "approve" or "dismiss", each a non-empty array of '
          + '{ "slug": ... } — and send it as JSON (Content-Type: application/json).',
      );
    }
    return this.sensorReview.review(id, body, scope.userId);
  }

  @Get('template')
  @Requires('catalog.write')
  @ApiOperation({ summary: 'Download the current workbook template' })
  async downloadTemplate(): Promise<StreamableFile> {
    const buffer = await this.templates.build();
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="equipment-library-template.xlsx"',
    });
  }
}
