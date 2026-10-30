-- Development demo-data cleanup from the 29 Oct test report (MIN-9, class names).
-- One transaction: each statement asserts the exact number of rows it may touch and the
-- whole run rolls back otherwise. Run with psql -v ON_ERROR_STOP=1.
-- Not touched: published library rows (equipment_class_profile, scenario_definition) are
-- immutable by design (G13); their "&amp;" names and the two cut scenario descriptions
-- need a new version from a Things Alive catalog author.
\set ON_ERROR_STOP on
BEGIN;

\echo '== before'
SELECT id, enabled, left(name, 60) AS name, params->>'signal' AS signal FROM alert_rule
 WHERE tenant_id = 'demo-construction'
   AND id IN ('ccc8cc89-a2b8-4bdd-8b2c-41d843e6a5ea', '8c6fa236-b995-4fac-ba0d-ae4d9a0608ed',
              'ea74ee2f-bf05-4d2a-b893-9f2653632542', '9714ee48-66c0-4a19-bfe9-2ea7f30013a3');

DO $$
DECLARE n int;
BEGIN
  -- Disable (never delete: alert events point at their rule):
  --   ccc8cc89  "Notify me if pump energy…" watching engine coolant > 55
  --   8c6fa236  "Alert team if pressure drop…" = engine oil pressure > 15, fires on every normal reading
  --   ea74ee2f  "Engine coolant above 105 °C", a duplicate of 8a791f6e (same signal, bound, scope)
  --   9714ee48  watches coolant_temperature, a signal no machine reports, so it can never fire
  UPDATE alert_rule SET enabled = false, updated_by = 'test-report-cleanup', updated_at = now()
   WHERE tenant_id = 'demo-construction' AND enabled
     AND id IN ('ccc8cc89-a2b8-4bdd-8b2c-41d843e6a5ea', '8c6fa236-b995-4fac-ba0d-ae4d9a0608ed',
                'ea74ee2f-bf05-4d2a-b893-9f2653632542', '9714ee48-66c0-4a19-bfe9-2ea7f30013a3');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 4 THEN RAISE EXCEPTION 'expected to disable 4 alert rules, matched %; nothing changed', n; END IF;

  -- The account's own class copies: "&amp;" stored literally, shown on screen as "&amp;amp;".
  UPDATE client_equipment_class SET name = replace(name, '&amp;', '&'), updated_by = 'test-report-cleanup', updated_at = now()
   WHERE tenant_id = 'demo-construction' AND name LIKE '%&amp;%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 4 THEN RAISE EXCEPTION 'expected at most 4 class names, matched %; nothing changed', n; END IF;
END $$;

\echo '== after'
SELECT id, enabled, left(name, 60) AS name FROM alert_rule
 WHERE tenant_id = 'demo-construction' AND updated_by = 'test-report-cleanup';
SELECT slug, name FROM client_equipment_class WHERE tenant_id = 'demo-construction' AND updated_by = 'test-report-cleanup';

COMMIT;
