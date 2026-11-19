import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What to do about an alert, in words a customer can be told (19 Nov 2026).
 *
 * Vani's machine packet has a `recommended_action` field (integration guide §6.2), and
 * Vani speaks only from the packet. 2.0 had nothing to put there: a library
 * recommendation hangs off a failure mode, and nothing links an alert to one. Guessing
 * the failure mode from the alert's signal was considered and set aside — a "coolant
 * below 0 °C" alert would have borrowed the overheat fix and Vani would have told a
 * customer to clear the radiator fins.
 *
 * So the rule says it, explicitly. Authored on the template by Things Alive, copied
 * with the rest of the rule, and the account's own to change after that, like every
 * other field of a copied rule. NULL means nobody wrote one, and then the call simply
 * carries none; nothing is composed in its place.
 *
 * Both CHECKs refuse what would be read aloud badly: a blank string (Vani would say
 * nothing where a sentence was promised) and a paragraph (a phone call is not where a
 * procedure is read out).
 */
export class AlertRecommendedAction1765800000000 implements MigrationInterface {
  name = 'AlertRecommendedAction1765800000000';

  public async up(q: QueryRunner): Promise<void> {
    for (const table of ['alert_rule_template', 'alert_rule']) {
      await q.query(`
        ALTER TABLE "${table}"
          ADD COLUMN "recommended_action" text,
          ADD CONSTRAINT "ck_${table}_recommended_action"
            CHECK ("recommended_action" IS NULL
                   OR (length(btrim("recommended_action")) > 0 AND length("recommended_action") <= 300))`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of ['alert_rule', 'alert_rule_template']) {
      await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "ck_${table}_recommended_action"`);
      await q.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "recommended_action"`);
    }
  }
}
