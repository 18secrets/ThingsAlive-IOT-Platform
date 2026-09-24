import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogImportController } from './catalog-import.controller';
import { CatalogImportBatch } from './entities/catalog-import-batch.entity';
import { CatalogImportRow } from './entities/catalog-import-row.entity';
import { CatalogImportApplyService } from './services/catalog-import-apply.service';
import { CatalogImportDiffService } from './services/catalog-import-diff.service';
import { CatalogImportValidatorService } from './services/catalog-import-validator.service';
import { CatalogTemplateService } from './services/catalog-template.service';
import { WorkbookParserService } from './services/workbook-parser.service';

/**
 * Staging, validation, the dry-run diff and apply for the Excel catalog import
 * (tasks QIMP1, QIMP2, QIMP3). The validator, diff and apply services read
 * `EquipmentClassProfile`, `EquipmentClassFormula`, `EquipmentClassSensorRequirement`,
 * `Sensor` and `SensorRoleCapability` directly off the shared `DataSource` rather
 * than through `TypeOrmModule.forFeature` here, the same pattern `CredentialService`
 * and `ProjectionService` already use — they are not this module's tables to own.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CatalogImportBatch, CatalogImportRow])],
  controllers: [CatalogImportController],
  providers: [
    WorkbookParserService, CatalogTemplateService, CatalogImportValidatorService,
    CatalogImportDiffService, CatalogImportApplyService,
  ],
  exports: [
    WorkbookParserService, CatalogTemplateService, CatalogImportValidatorService,
    CatalogImportDiffService, CatalogImportApplyService,
  ],
})
export class CatalogImportModule {}
