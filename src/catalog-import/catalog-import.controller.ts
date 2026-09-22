import {
  BadRequestException, Controller, Get, Param, Post, StreamableFile, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Requires } from '../auth/guards/capability.guard';
import { RequestScope } from '../auth/types/request-scope';
import { CatalogImportDiffService } from './services/catalog-import-diff.service';
import { CatalogImportValidatorService } from './services/catalog-import-validator.service';
import { CatalogTemplateService } from './services/catalog-template.service';
import { CatalogImportRefusal, WorkbookParserService } from './services/workbook-parser.service';

/**
 * The Excel catalog import, over HTTP (task QIMP2).
 *
 * `catalog.write` throughout — the same capability the rest of catalog authoring
 * already requires (`src/catalog/catalog.controller.ts`). Staging a workbook is
 * authoring the library, not a new kind of action that needs its own permission.
 */
@ApiTags('Catalog Import')
@Controller('platform/catalog')
export class CatalogImportController {
  constructor(
    private readonly parser: WorkbookParserService,
    private readonly validator: CatalogImportValidatorService,
    private readonly diff: CatalogImportDiffService,
    private readonly templates: CatalogTemplateService,
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
