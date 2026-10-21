import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Grants `ta_app` the privilege `DELETE /imports/:id` actually needs (task QIMP4).
 *
 * `1757980000000-CatalogImport.ts` granted `SELECT, INSERT, UPDATE` on both import
 * tables — there was no delete path yet, so there was nothing to grant. Discarding
 * an un-applied batch needs `DELETE` on `catalog_import_batch` itself; its rows go
 * with it through the existing `ON DELETE CASCADE` on `catalog_import_row`, which
 * needs no grant of its own — cascade deletes are enforced by the foreign key, not
 * reissued as a privilege check against the referencing table.
 */
export class AllowImportBatchDiscard1758050000000 implements MigrationInterface {
  name = 'AllowImportBatchDiscard1758050000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`GRANT DELETE ON "catalog_import_batch" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`REVOKE DELETE ON "catalog_import_batch" FROM "ta_app"`);
  }
}
