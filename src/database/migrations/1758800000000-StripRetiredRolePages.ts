import { MigrationInterface, QueryRunner } from 'typeorm';
import { TENANT_ASSIGNABLE_PAGES } from '../../identity/pages';

/**
 * Strips every page the vocabulary no longer holds from stored `tenant_role.allowed_tabs`
 * (task QFIX-ROLES).
 *
 * `BackfillTenantRoleAllowedTabs1757951000000` wrote `alert-agent` into the three
 * template roles of every account; MR !53 then removed `alert-agent` from
 * `TENANT_ASSIGNABLE_PAGES`, and nothing cleaned what was stored. `validateAllowedTabs`
 * refuses an unknown page, correctly, so every one of those roles failed to save the
 * moment anyone edited it — and only the console's own sanitising hid that. Invalid
 * data with one caller that cleans it and another that fails is the shape to avoid; the
 * fix belongs in the data, not in a more lenient validator.
 *
 * Written against the vocabulary constant, not the string `'alert-agent'`: hard-coding
 * the one page retired this time invites the next person to copy it for the next one.
 * Pages that survive keep their order. A second run finds nothing to change.
 */
export class StripRetiredRolePages1758800000000 implements MigrationInterface {
  name = 'StripRetiredRolePages1758800000000';

  public async up(q: QueryRunner): Promise<void> {
    const vocabulary = [...TENANT_ASSIGNABLE_PAGES];
    const changed: { tenant_id: string }[] = await q.query(
      `UPDATE "tenant_role"
          SET "allowed_tabs" = ARRAY(
                SELECT t.page FROM unnest("allowed_tabs") WITH ORDINALITY AS t(page, i)
                 WHERE t.page = ANY($1::text[]) ORDER BY t.i)
        WHERE NOT ("allowed_tabs" <@ $1::text[])
      RETURNING "tenant_id"`,
      [vocabulary],
    );
    // The count is the report: zero where roles were expected to hold a retired page
    // would mean the backfill never ran where we think it did, and that is worth a
    // line in the deploy log rather than a silent success.
    const rows = Array.isArray(changed[0]) ? (changed[0] as { tenant_id: string }[]) : changed;
    const tenants = new Set(rows.map((r) => r.tenant_id)).size;
    console.log(`StripRetiredRolePages: ${rows.length} role(s) changed in ${tenants} tenant(s).`);
  }

  public async down(): Promise<void> {
    // Deliberately empty. The pages removed here are ones the application now refuses
    // to save; putting them back is not a reversal, it is reintroducing the defect this
    // migration exists to remove.
  }
}
