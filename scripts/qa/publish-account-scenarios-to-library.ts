import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/database/data-source';

/**
 * Fuel test report FU-2 / TC-FP-02, test report OB-1: "Fuel prediction exists only on the
 * seed class demo-excavator; hydraulic-excavator has 0 scenarios."
 *
 * On Development the demo account already runs five scenarios on each of 15 classes,
 * fuel-burn among them, as its own copies (written there by the onboarding scripts, not
 * from the library). The library classes themselves hold none, so an account granted
 * hydraulic-excavator today gets no prediction at all. This publishes, for each library
 * class with no published scenario, the scenarios one account runs on it, as version 1.
 *
 *   DATABASE_URL=<owner url> npx ts-node scripts/qa/publish-account-scenarios-to-library.ts demo-construction            # dry run
 *   DATABASE_URL=<owner url> npx ts-node scripts/qa/publish-account-scenarios-to-library.ts demo-construction --apply    # write
 *
 * What authoring would refuse is refused here too: a scenario needs at least one signal,
 * and every signal it requires must be declared by the class's newest published version.
 * Only classes with no published scenario are touched, and a slug the library already
 * has is skipped, so it runs once and a second run writes nothing. Inserts only; nothing
 * existing changes. Published definitions are immutable (D05): to take one back, retire
 * it (status = 'retired'), as authoring does; accounts already copied keep theirs.
 */
async function main() {
  const tenant = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!tenant || tenant.startsWith('--')) throw new Error('Usage: publish-account-scenarios-to-library.ts <tenant_id> [--apply]');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (the owner\'s login).');
  const ds = new DataSource(dataSourceOptions(process.env, { appRole: null }));
  await ds.initialize();
  try {
    await ds.transaction(async (m) => {
      const candidates: { slug: string; cls: string; name: string; description: string | null; severity: string;
        tier: number; required_signals: string[]; minimum_history_days: number; parameters: unknown; undeclared: string[] }[] =
        await m.query(
          `WITH lib AS (
             SELECT DISTINCT ON ("slug") "slug", "expected_signals"
               FROM "equipment_class_profile" WHERE "status" = 'published' ORDER BY "slug", "version" DESC)
           SELECT cs."slug", cs."client_equipment_class_slug" AS cls, cs."name", cs."description", cs."severity",
                  cs."tier", cs."required_signals", cs."minimum_history_days", cs."parameters",
                  ARRAY(SELECT s FROM unnest(cs."required_signals") s
                         WHERE NOT lib."expected_signals" @> jsonb_build_array(jsonb_build_object('signal', s))) AS undeclared
             FROM "client_scenario" cs
             JOIN lib ON lib."slug" = cs."client_equipment_class_slug"
            WHERE cs."tenant_id" = $1 AND cs."status" <> 'retired'
              AND NOT EXISTS (SELECT 1 FROM "scenario_definition" d
                               WHERE d."equipment_class_slug" = cs."client_equipment_class_slug" AND d."status" = 'published')
              AND NOT EXISTS (SELECT 1 FROM "scenario_definition" d
                               WHERE d."slug" IN (cs."slug", cs."client_equipment_class_slug" || '-' || cs."slug"))
            ORDER BY cs."client_equipment_class_slug", cs."slug"`,
          [tenant],
        );
      const refused = candidates.filter((c) => !c.required_signals.length || c.undeclared.length);
      const ok = candidates.filter((c) => c.required_signals.length && !c.undeclared.length);
      for (const r of refused) {
        console.log(`skip ${r.slug}: ${r.required_signals.length ? `class does not declare ${r.undeclared.join(', ')}` : 'requires no signal'}`);
      }
      const classes = [...new Set(ok.map((c) => c.cls))];
      console.log(`${ok.length} scenario(s) on ${classes.length} class(es) to publish: ${classes.join(', ')}`);
      if (!apply || !ok.length) {
        if (!apply) console.log('Dry run: nothing written. Add --apply to write.');
        return;
      }
      // Library slugs are global. An account may name its copy "fuel-burn"; in the library
      // that would claim the name for one class, so it is published under the class's
      // prefix, as the rest are. (Run on Development on 4 Nov before this was here: the
      // five bare hydraulic-excavator slugs were retired and republished prefixed.)
      for (const c of ok) {
        if (!c.slug.startsWith(`${c.cls}-`)) c.slug = `${c.cls}-${c.slug}`;
        await m.query(
          `INSERT INTO "scenario_definition"
             ("slug", "version", "equipment_class_slug", "name", "description", "severity", "tier",
              "required_signals", "minimum_history_days", "parameters", "status", "published_at")
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7::text[], $8, $9::jsonb, 'published', now())`,
          [c.slug, c.cls, c.name, c.description, c.severity, c.tier, c.required_signals, c.minimum_history_days,
            JSON.stringify(c.parameters)],
        );
      }
      console.log(`Published ${ok.length} scenario(s). Undo: UPDATE scenario_definition SET status = 'retired' WHERE slug = ANY('{${ok.map((c) => c.slug).join(',')}}');`);
    });
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
