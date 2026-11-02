-- Read-only diagnosis of the test report's demo-data findings (MIN-9, MIN-14).
-- Run with PGOPTIONS='-c default_transaction_read_only=on' so the server refuses any write.
\pset footer off
\echo '== 1. Alert rules in demo-construction (MIN-9: prompt-named rules, near-duplicates)'
SELECT id, left(name, 70) AS name, trigger, params->>'signal' AS signal, params->>'min' AS min, params->>'max' AS max,
       applies_to, external_id, enabled, compiled_from_workflow_id IS NOT NULL AS from_workflow, created_at::date
  FROM alert_rule WHERE tenant_id = 'demo-construction' ORDER BY params->>'signal', created_at;

\echo '== 2. Rules whose name mentions one thing and whose signal is another (MIN-9: pump rule on coolant)'
SELECT id, name, params->>'signal' AS signal FROM alert_rule
 WHERE tenant_id = 'demo-construction'
   AND ((name ILIKE '%pump%' OR name ILIKE '%energy%') AND coalesce(params->>'signal','') ILIKE '%coolant%');

\echo '== 3. Rules whose names read like a typed prompt (long, or a question/instruction)'
SELECT id, name FROM alert_rule WHERE tenant_id = 'demo-construction'
   AND (length(name) > 60 OR name ~* '^(alert|notify|tell|let me|when|if|create|send|warn)\M' OR name LIKE '%?%');

\echo '== 4. EX-03: register, fitted logger, bindings, latest reading (MIN-14: stale)'
SELECT source_system, external_id, name, status, equipment_class_slug FROM equipment_profile
 WHERE tenant_id = 'demo-construction' AND external_id = 'EX-03';
SELECT imei, state, equipment_external_id, assigned_at, updated_at FROM device_inventory
 WHERE tenant_id = 'demo-construction' AND (equipment_external_id = 'EX-03' OR imei = '358000000000300');
SELECT signal_key, imei, status, valid_from::date, valid_to::date FROM signal_binding_version
 WHERE tenant_id = 'demo-construction' AND external_id = 'EX-03' ORDER BY signal_key, valid_from;
SELECT imei, max(source_timestamp) AS latest, count(*) FILTER (WHERE source_timestamp > now() - interval '7 days') AS last_7d
  FROM telemetry_reading WHERE tenant_id = 'demo-construction' AND imei = '358000000000300' GROUP BY imei;
\echo '== 5. Fleet freshness for comparison: newest reading per fitted logger'
SELECT d.equipment_external_id, max(t.source_timestamp) AS latest
  FROM device_inventory d LEFT JOIN telemetry_reading t ON t.imei = d.imei AND t.tenant_id = d.tenant_id AND t.source_timestamp > now() - interval '14 days'
 WHERE d.tenant_id = 'demo-construction' AND d.state = 'assigned' AND d.equipment_external_id LIKE 'EX-%'
 GROUP BY 1 ORDER BY 1;
