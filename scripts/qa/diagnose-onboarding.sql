-- Read-only: why Add Equipment offers 1 class and a library machine adopts no scenarios (OB-1, OB-4).
\pset footer off
\echo '== 1. Entitlements for demo-construction'
SELECT * FROM client_catalog_entitlement WHERE tenant_id = 'demo-construction';
\echo '== 2. Published library classes (latest per slug)'
SELECT DISTINCT ON (slug) slug, version, name FROM equipment_class_profile WHERE status = 'published' ORDER BY slug, version DESC;
\echo '== 3. The account''s own class copies'
SELECT slug, name, template_slug, template_version, status FROM client_equipment_class WHERE tenant_id = 'demo-construction' ORDER BY slug;
\echo '== 4. The account''s scenario copies per class'
SELECT client_equipment_class_slug, count(*) AS scenarios, count(*) FILTER (WHERE enabled) AS enabled FROM client_scenario
 WHERE tenant_id = 'demo-construction' GROUP BY 1 ORDER BY 1;
\echo '== 5. Classes the fleet uses, and the two test machines'
SELECT equipment_class_slug, count(*) FROM equipment_profile WHERE tenant_id = 'demo-construction' GROUP BY 1 ORDER BY 1;
SELECT source_system, external_id, name, equipment_class_slug, class_version, created_at FROM equipment_profile
 WHERE tenant_id = 'demo-construction' AND (external_id ILIKE '%DIPPY%' OR name ILIKE '%DIPPY%');
\echo '== 6. Client equipment templates'
SELECT * FROM client_equipment_template WHERE tenant_id = 'demo-construction';
\echo '== 7. Scenario descriptions that end mid-sentence (COS-4), library and the account''s copies'
SELECT 'library' AS src, slug, right(description, 60) AS ends_with FROM scenario_definition
 WHERE status = 'published' AND description IS NOT NULL AND description !~ '[.!?)"]\s*$'
UNION ALL
SELECT 'account', slug, right(description, 60) FROM client_scenario
 WHERE tenant_id = 'demo-construction' AND description IS NOT NULL AND description !~ '[.!?)"]\s*$'
ORDER BY 1, 2;
