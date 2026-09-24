import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type CatalogImportRowStatus = 'parsed' | 'valid' | 'invalid' | 'applied' | 'skipped';

/**
 * One row from one sheet of one uploaded workbook (task QIMP1).
 *
 * Every row is kept, including the rejected ones — an import that silently drops rows
 * is how a class ends up half-loaded with nobody able to say which half.
 */
@Entity('catalog_import_row')
@Index('uq_catalog_import_row', ['batchId', 'sheet', 'rowNumber'], { unique: true })
export class CatalogImportRow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId: string;

  @Column({ type: 'text' })
  sheet: string;

  /** The row number as the person sees it in Excel. */
  @Column({ name: 'row_number', type: 'int' })
  rowNumber: number;

  @Column({ name: 'entity_kind', type: 'text' })
  entityKind: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'text', default: 'parsed' })
  status: CatalogImportRowStatus;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  /** What it resolved to, once applied. */
  @Column({ name: 'target_ref', type: 'text', nullable: true })
  targetRef: string | null;
}
