import { Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { ALL_SHEETS, KNOWN_ENUMS, META_SHEET, TEMPLATE_VERSION } from '../template-schema';

/**
 * Builds the workbook whoever writes the library content fills in (task QIMP1).
 *
 * Every sheet the parser reads, with the exact headers it checks for, one filled
 * example row so the shape is never guessed, and an `_enums` sheet listing every fixed
 * vocabulary this importer knows about — so the file is self-explaining without a
 * separate document.
 */
@Injectable()
export class CatalogTemplateService {
  async build(now: Date = new Date()): Promise<Buffer> {
    const workbook = new Workbook();

    for (const schema of ALL_SHEETS) {
      const sheet = workbook.addWorksheet(schema.sheet);
      sheet.columns = schema.columns.map((c) => ({ header: c.name, key: c.name, width: 24 }));

      const example = { ...schema.example };
      if (schema.sheet === META_SHEET.sheet) {
        example.template_version = TEMPLATE_VERSION;
        example.generated_at = now.toISOString();
      }
      sheet.addRow(example);
    }

    const enumSheet = workbook.addWorksheet('_enums');
    enumSheet.columns = [
      { header: 'field', key: 'field', width: 32 },
      { header: 'allowed_values', key: 'allowed_values', width: 60 },
    ];
    for (const e of KNOWN_ENUMS) {
      enumSheet.addRow({ field: e.field, allowed_values: e.values.join(', ') });
    }

    // exceljs's own typings shadow the global `Buffer` with a legacy, non-generic
    // definition incompatible with @types/node's — a known mismatch between the two
    // packages, not a real type error. The cast is the boundary; everything on our
    // side of it is a real Node Buffer.
    return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  }
}
