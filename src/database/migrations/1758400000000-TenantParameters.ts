import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Client parameters and cost profiles (task QPARAM1).
 *
 * Four scopes — client, site, equipment class, equipment — each effective-dated, each
 * resolved per field. Costs and currency are the client's alone (D39), so this is an
 * ordinary tenant table with FORCEd isolation and no platform exception of any kind.
 *
 * The rules that protect the data live here rather than in the service, because a
 * service check loses to a concurrent write and the next repository method will not
 * know they existed:
 *
 *  - append-only, for every role including the owner — the history is the audit trail;
 *  - a value's shape (a currency code, a number, a positive whole number of seconds);
 *  - currency lives at client scope and nowhere else;
 *  - the client currency cannot change while a cost-typed value exists (§0.3). No
 *    conversion: the platform has no exchange rates, and inventing one is worse than
 *    refusing.
 */
export class TenantParameters1758400000000 implements MigrationInterface {
  name = 'TenantParameters1758400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "tenant_parameter" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" text NOT NULL,
        "scope" text NOT NULL,
        "scope_ref" text,
        "name" text NOT NULL,
        "value" jsonb NOT NULL,
        "unit" text,
        "effective_from" timestamptz NOT NULL,
        "created_by" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_tenant_parameter_scope"
          CHECK ("scope" IN ('client', 'site', 'equipment_class', 'equipment')),
        -- Client scope has nothing to refer to; every other scope must say which one.
        CONSTRAINT "ck_tenant_parameter_scope_ref"
          CHECK (("scope" = 'client') = ("scope_ref" IS NULL)),
        -- One currency per client. A site in another currency would make every
        -- fleet-wide cost sum add numbers that are not the same kind of number.
        CONSTRAINT "ck_tenant_parameter_currency_scope"
          CHECK ("name" <> 'currency' OR "scope" = 'client'),
        -- CASE rather than OR: Postgres does not promise to evaluate an OR's arms in
        -- order, and the cast in the second arm throws on a string.
        CONSTRAINT "ck_tenant_parameter_value"
          CHECK (CASE
            WHEN jsonb_typeof("value") = 'null' THEN true
            WHEN "name" = 'currency' THEN
              jsonb_typeof("value") = 'string' AND ("value" #>> '{}') ~ '^[A-Z]{3}$'
            WHEN jsonb_typeof("value") <> 'number' THEN false
            WHEN "name" = 'stale_after_seconds' THEN
              ("value" #>> '{}')::numeric > 0
              AND ("value" #>> '{}')::numeric = trunc(("value" #>> '{}')::numeric)
            ELSE true
          END)
      )`);
    // COALESCE because a NULL scope_ref never compares equal, which would let two client
    // rows for the same name and instant both in — and resolution would then depend on
    // which one it happened to read.
    await q.query(`
      CREATE UNIQUE INDEX "uq_tenant_parameter_version"
        ON "tenant_parameter" ("tenant_id", "scope", COALESCE("scope_ref", ''), "name", "effective_from")`);
    await q.query(`
      CREATE INDEX "ix_tenant_parameter_lookup"
        ON "tenant_parameter" ("tenant_id", "name", "scope", "scope_ref", "effective_from" DESC)`);

    // ------------------------------------------------------------------ append-only
    // A trigger rather than only a missing grant: the owner and a managed Postgres's
    // superuser bypass grants, and a history that the right login can rewrite is not one.
    await q.query(`
      CREATE FUNCTION "tenant_parameter_append_only"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'tenant_parameter is append-only: record a change as a new row with a later effective_from (tenant_parameter_append_only)';
      END $$`);
    await q.query(`
      CREATE TRIGGER "tg_tenant_parameter_append_only"
        BEFORE UPDATE OR DELETE ON "tenant_parameter"
        FOR EACH ROW EXECUTE FUNCTION "tenant_parameter_append_only"()`);

    // ---------------------------------------------------------------- currency guard
    // The database's copy of `costTyped` in parameter-catalog.ts. Two lists are one
    // too many, but the guard has to hold for a write that never passed the service;
    // a test asserts they agree.
    await q.query(`
      CREATE FUNCTION "tenant_parameter_cost_names"() RETURNS text[]
      LANGUAGE sql IMMUTABLE AS $$
        SELECT ARRAY['fuel_price', 'labour_rate_per_hour', 'operating_cost_per_hour']::text[]
      $$`);
    // A cost value "exists" when the latest row for its (scope, scope_ref, name) is not
    // a clear — including one effective in the future, which is a value the client has
    // already entered in the current currency.
    await q.query(`
      CREATE FUNCTION "tenant_parameter_cost_values"(p_tenant text)
      RETURNS TABLE ("scope" text, "values_count" bigint)
      LANGUAGE sql STABLE AS $$
        SELECT latest."scope", count(*)
          FROM (
            SELECT DISTINCT ON (tp."scope", COALESCE(tp."scope_ref", ''), tp."name")
                   tp."scope", tp."value"
              FROM "tenant_parameter" tp
             WHERE tp."tenant_id" = p_tenant
               AND tp."name" = ANY ("tenant_parameter_cost_names"())
             ORDER BY tp."scope", COALESCE(tp."scope_ref", ''), tp."name", tp."effective_from" DESC
          ) latest
         WHERE jsonb_typeof(latest."value") <> 'null'
         GROUP BY latest."scope"
         ORDER BY latest."scope"
      $$`);
    // The advisory lock serialises every parameter write for one tenant, so a currency
    // change and a cost value cannot each pass the check without seeing the other.
    await q.query(`
      CREATE FUNCTION "tenant_parameter_currency_guard"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        current_value jsonb;
        in_force text;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('tenant_parameter:' || NEW."tenant_id"));
        IF NEW."name" <> 'currency' THEN
          RETURN NEW;
        END IF;
        SELECT tp."value" INTO current_value
          FROM "tenant_parameter" tp
         WHERE tp."tenant_id" = NEW."tenant_id" AND tp."scope" = 'client' AND tp."name" = 'currency'
         ORDER BY tp."effective_from" DESC
         LIMIT 1;
        -- Setting the first currency is not a change: nothing was denominated in
        -- another one. Re-stating the same one is not a change either.
        IF current_value IS NULL OR jsonb_typeof(current_value) = 'null' OR current_value = NEW."value" THEN
          RETURN NEW;
        END IF;
        SELECT string_agg(c."values_count" || ' at ' || c."scope", ', ')
          INTO in_force
          FROM "tenant_parameter_cost_values"(NEW."tenant_id") c;
        IF in_force IS NOT NULL THEN
          RAISE EXCEPTION 'cannot change currency while cost values exist (%): clear them first (currency_conflict)', in_force;
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`
      CREATE TRIGGER "tg_tenant_parameter_currency_guard"
        BEFORE INSERT ON "tenant_parameter"
        FOR EACH ROW EXECUTE FUNCTION "tenant_parameter_currency_guard"()`);

    // -------------------------------------------------------------------------- RLS
    await q.query(`ALTER TABLE "tenant_parameter" ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE "tenant_parameter" FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY "tenant_isolation" ON "tenant_parameter"
        USING (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )
        WITH CHECK (
          current_setting('ta.bypass', true) = 'on'
          OR "tenant_id" = current_setting('ta.tenant_id', true)
        )`);
    // No UPDATE and no DELETE — the trigger refuses them anyway, and a grant that
    // promises what the table will not do is a misleading grant.
    await q.query(`GRANT SELECT, INSERT ON "tenant_parameter" TO "ta_app"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "tenant_parameter"`);
    await q.query(`DROP FUNCTION IF EXISTS "tenant_parameter_currency_guard"()`);
    await q.query(`DROP FUNCTION IF EXISTS "tenant_parameter_cost_values"(text)`);
    await q.query(`DROP FUNCTION IF EXISTS "tenant_parameter_cost_names"()`);
    await q.query(`DROP FUNCTION IF EXISTS "tenant_parameter_append_only"()`);
  }
}
