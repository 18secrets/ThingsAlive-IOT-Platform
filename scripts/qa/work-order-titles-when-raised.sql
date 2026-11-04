-- Test report MIN-8: a work order's title carries the risk it was raised at, and since the
-- 30 Oct fix new ones say so ("...: risk 100 when raised"). The 17 raised before it on
-- Development still read "...: risk 100", beside today's lower score. This appends
-- " when raised" to those titles. History (work_order_event) is append-only and untouched;
-- the console shows old raise notes without the uuid instead.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/qa/work-order-titles-when-raised.sql
--
-- One transaction; it asserts the row count it expects and rolls back otherwise. Prints the
-- rows as they were first, which is what an undo restores (strip the suffix again).
\set ON_ERROR_STOP on
BEGIN;

\echo '== before (the backup)'
SELECT id, reference, title FROM work_order
 WHERE tenant_id = 'demo-construction' AND title ~ ': risk [0-9]+$' ORDER BY reference;

DO $$
DECLARE n int;
BEGIN
  UPDATE work_order SET title = title || ' when raised'
   WHERE tenant_id = 'demo-construction' AND title ~ ': risk [0-9]+$';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 17 THEN RAISE EXCEPTION 'expected at most 17 titles, matched %; nothing changed', n; END IF;
END $$;

\echo '== after'
SELECT reference, title FROM work_order WHERE tenant_id = 'demo-construction' AND title LIKE '% when raised' ORDER BY reference;
COMMIT;
