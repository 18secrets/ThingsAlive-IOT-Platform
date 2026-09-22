import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogImportController } from './catalog-import.controller';
import { CatalogImportBatch } from './entities/catalog-import-batch.entity';
import { CatalogImportRow } from './entities/catalog-import-row.entity';
import { CatalogImportDiffService } from './services/catalog-import-diff.service';
import { CatalogImportValidatorService } from './services/catalog-import-validator.service';
import { CatalogTemplateService } from './services/catalog-template.service';
import { WorkbookParserService } from './services/workbook-parser.service';

/**
 * Staging, validation and the dry-run diff for the Excel catalog import (tasks
 * QIMP1, QIMP2). The validator and diff services read `EquipmentClassProfile`,
 * `EquipmentClassFormula` and `Sensor` directly off the shared `DataSource` rather
 * than through `TypeOrmModule.forFeature` here, the same pattern `CredentialService`
 * and `ProjectionService` already use — they are not this module's tables to own.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CatalogImportBatch, CatalogImportRow])],
  controllers: [CatalogImportController],
  providers: [
    WorkbookParserService, CatalogTemplateService, CatalogImportValidatorService, CatalogImportDiffService,
  ],
  exports: [WorkbookParserService, CatalogTemplateService, CatalogImportValidatorService, CatalogImportDiffService],
})
export class CatalogImportModule {}
