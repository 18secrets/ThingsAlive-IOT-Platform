import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogImportBatch } from './entities/catalog-import-batch.entity';
import { CatalogImportRow } from './entities/catalog-import-row.entity';
import { CatalogTemplateService } from './services/catalog-template.service';
import { WorkbookParserService } from './services/workbook-parser.service';

/**
 * Staging for the Excel catalog import (task QIMP1).
 *
 * No controller yet, and so not wired into `AppModule`: there is nothing for a route
 * to call until QIMP2 adds validation and something worth exposing over HTTP.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CatalogImportBatch, CatalogImportRow])],
  providers: [WorkbookParserService, CatalogTemplateService],
  exports: [WorkbookParserService, CatalogTemplateService],
})
export class CatalogImportModule {}
