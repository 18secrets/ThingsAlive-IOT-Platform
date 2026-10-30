-- Read-only follow-up (OB-1, OB-2): the two test machines, and engine_load per excavator class.
\pset footer off
\echo '== 1. The two test machines'
SELECT source_system, external_id, name, equipment_class_slug, class_version, origin, status FROM equipment_profile
 WHERE tenant_id = 'demo-construction' AND (external_id ILIKE '%DIPPY%' OR name ILIKE '%DIPPY%');
\echo '== 2. Signals each excavator class requires (latest published version)'
SELECT r.class_slug, r.class_version, string_agg(r.measurement_role, ', ' ORDER BY r.measurement_role) AS required
  FROM equipment_class_sensor_requirement r
  JOIN (SELECT slug, max(version) AS v FROM equipment_class_profile WHERE status = 'published' GROUP BY slug) p
    ON p.slug = r.class_slug AND p.v = r.class_version
 WHERE r.class_slug IN ('demo-excavator', 'hydraulic-excavator')
 GROUP BY 1, 2;
\echo '== 3. Signals the account''s excavator scenarios require'
SELECT client_equipment_class_slug, slug, array_to_string(required_signals, ', ') AS required FROM client_scenario
 WHERE tenant_id = 'demo-construction' AND client_equipment_class_slug IN ('demo-excavator', 'hydraulic-excavator') ORDER BY 1, 2;
\echo '== 4. Names stored HTML-escaped'
SELECT 'library' AS src, slug, version, name FROM equipment_class_profile WHERE name LIKE '%&amp;%'
UNION ALL SELECT 'account', slug, NULL, name FROM client_equipment_class WHERE tenant_id = 'demo-construction' AND name LIKE '%&amp;%'
ORDER BY 1, 2;
