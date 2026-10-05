# Schema inventory

Generated, not written. Every table on a database migrated from empty with the full chain,
excluding monthly partitions and the `migrations` table. Check here before building a table,
column or constraint a prompt specifies — if it already exists, stop and report.

Generated 2026-10-05 against `main` @ `b1d20b8`, 49 migrations, newest `SignalFreshness1758090000000`.

**Regenerate at rebase**, after the other stream's merge (`two-stream-development-plan.md` §4):
create an empty database, `npm run build && npm run migration:run` against it, then run the
query in the comment at the end of this file with `psql -At` and replace everything below
the line.

---

## `alert_event` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `rule_id` uuid not null
- `rule_name` text not null
- `source_system` text not null
- `external_id` text not null
- `severity` text not null
- `summary` text not null
- `evidence` jsonb not null
- `shift_local_date` text
- `window_start` timestamp with time zone
- `window_end` timestamp with time zone
- `prediction_id` uuid
- `state` text not null
- `acknowledged_by` text
- `acknowledged_at` timestamp with time zone
- `resolved_by` text
- `resolved_at` timestamp with time zone
- `resolution_note` text
- `fired_at` timestamp with time zone not null

## `alert_rule` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `slug` text not null
- `name` text not null
- `description` text
- `trigger` text not null
- `params` jsonb not null
- `applies_to` text not null
- `plant_id` uuid
- `source_system` text
- `external_id` text
- `severity` text not null
- `enabled` boolean not null
- `created_by` text
- `updated_by` text
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null
- `template_slug` text
- `template_version` integer
- `template_checksum` text
- `copied_at` timestamp with time zone
- `equipment_class_slug` text

## `alert_rule_template`

- `id` uuid not null
- `slug` text not null
- `version` integer not null
- `equipment_class_slug` text not null
- `name` text not null
- `description` text
- `trigger` text not null
- `params` jsonb not null
- `severity` text not null
- `enabled_on_copy` boolean not null
- `status` text not null
- `published_at` timestamp with time zone
- `created_by` text
- `created_at` timestamp with time zone not null

## `app_user` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `email` text not null
- `full_name` text not null
- `phone` text
- `role_slug` text not null
- `status` text not null
- `password_hash` text
- `external_user_id` text
- `external_source_system` text
- `invited_by` text
- `invited_at` timestamp with time zone
- `activated_at` timestamp with time zone
- `suspended_at` timestamp with time zone
- `suspended_reason` text
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null
- `failed_attempts` integer not null
- `locked_until` timestamp with time zone

## `calibration_version` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `method` text not null
- `points` jsonb not null
- `raw_unit` text
- `reference_unit` text
- `basis` text
- `performed_at` timestamp with time zone
- `effective_from` timestamp with time zone not null
- `expires_at` timestamp with time zone
- `certificate_ref` text
- `uncertainty` double precision
- `approved_by` text
- `approved_at` timestamp with time zone
- `created_at` timestamp with time zone not null

## `catalog_import_batch`

- `id` uuid not null
- `filename` text not null
- `checksum_sha256` text not null
- `template_version` text not null
- `uploaded_by` text not null
- `status` text not null
- `summary` jsonb not null
- `error` text
- `created_at` timestamp with time zone not null
- `applied_at` timestamp with time zone
- `applied_by` text
- `sensor_decisions` jsonb not null

## `catalog_import_row`

- `id` uuid not null
- `batch_id` uuid not null
- `sheet` text not null
- `row_number` integer not null
- `entity_kind` text not null
- `payload` jsonb not null
- `status` text not null
- `message` text
- `target_ref` text

## `causal_chain`

- `id` uuid not null
- `slug` text not null
- `version` integer not null
- `equipment_class_slug` text not null
- `scenario_slug` text
- `name` text not null
- `description` text
- `outcome` text
- `nodes` jsonb not null
- `alignment_seconds` integer
- `provenance` text
- `status` text not null
- `published_at` timestamp with time zone
- `created_by` text
- `created_at` timestamp with time zone not null

## `client_catalog_entitlement`

- `id` uuid not null
- `tenant_id` text not null
- `equipment_class_slug` text not null
- `granted_by` text not null
- `granted_at` timestamp with time zone not null
- `revoked_at` timestamp with time zone
- `revoked_by` text
- `note` text

## `client_equipment_class` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `slug` text not null
- `name` text not null
- `description` text
- `category` text
- `expected_signals` jsonb not null
- `failure_modes` jsonb not null
- `default_thresholds` jsonb not null
- `template_slug` text
- `template_version` integer
- `template_checksum` text
- `copied_at` timestamp with time zone
- `status` text not null
- `updated_by` text
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null

## `client_formula` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `client_equipment_class_slug` text not null
- `formula_key` text not null
- `kind` text not null
- `expression` text not null
- `compiled_plan` jsonb
- `compiled_at` timestamp with time zone
- `compiler_version` text
- `result_unit` text
- `required_signals` text[] not null
- `required_parameters` text[] not null
- `named_formula_slug` text
- `named_formula_version` integer
- `bindings` jsonb not null
- `result_kind` text
- `display_unit` text
- `display_format` text not null
- `target_value` double precision
- `target_min` double precision
- `target_max` double precision
- `target_direction` text not null
- `comparison_basis` text not null
- `aggregation_window` text not null
- `chart_type` text not null
- `template_version` integer
- `copied_at` timestamp with time zone
- `status` text not null
- `updated_by` text
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null

## `client_scenario` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `slug` text not null
- `client_equipment_class_slug` text not null
- `name` text not null
- `description` text
- `severity` text not null
- `tier` integer not null
- `required_signals` text[] not null
- `minimum_history_days` integer not null
- `parameters` jsonb not null
- `enabled` boolean not null
- `template_slug` text
- `template_version` integer
- `template_checksum` text
- `copied_at` timestamp with time zone
- `status` text not null
- `updated_by` text
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null

## `device_inventory` — RLS (forced)

- `id` uuid not null
- `imei` text not null
- `tenant_id` text
- `state` text not null
- `model` text
- `batch_ref` text
- `received_at` timestamp with time zone
- `assigned_at` timestamp with time zone
- `assigned_by` text
- `equipment_external_id` text
- `claimed_at` timestamp with time zone
- `claimed_by` text
- `notes` text
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null
- `tool_mapping_id` uuid

## `device_inventory_event` — RLS (forced)

- `id` uuid not null
- `imei` text not null
- `action` text not null
- `from_state` text
- `to_state` text not null
- `tenant_id` text
- `equipment_external_id` text
- `reason` text
- `actor_user_id` text not null
- `actor_roles` text[] not null
- `at` timestamp with time zone not null

## `device_link_health` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `imei` text not null
- `source_system` text not null
- `external_id` text not null
- `plant_id` uuid
- `local_date` text not null
- `window_start` timestamp with time zone not null
- `window_end` timestamp with time zone not null
- `state` text not null
- `detail` text not null
- `signal_scale` text
- `signal_median` double precision
- `signal_worst` double precision
- `signal_band` text
- `signal_worst_band` text
- `longest_gap_seconds` double precision
- `median_lag_seconds` double precision
- `max_lag_seconds` double precision
- `reported_signals` text[] not null
- `missing_signals` text[] not null
- `samples` integer not null
- `computed_at` timestamp with time zone not null

## `device_projection` — RLS (forced)

- `id` uuid not null
- `source_system` text not null
- `external_id` text not null
- `tenant_id` text not null
- `payload` jsonb not null
- `source_updated_at` timestamp with time zone
- `synced_at` timestamp with time zone not null
- `checksum` text not null
- `status` text not null
- `imei` text not null
- `equipment_external_id` text
- `name` text

## `domain_event`

- `id` uuid not null
- `event_type` text not null
- `tenant_id` text not null
- `subject` text not null
- `payload` jsonb not null
- `occurred_at` timestamp with time zone not null
- `delivery_state` text not null
- `delivered_at` timestamp with time zone
- `attempts` integer not null
- `last_error` text
- `created_at` timestamp with time zone not null

## `equipment_class_formula`

- `id` uuid not null
- `class_slug` text not null
- `class_version` integer not null
- `formula_key` text not null
- `kind` text not null
- `expression` text not null
- `inputs` text[] not null
- `output_unit` text
- `basis` text
- `references` jsonb not null
- `status` text not null
- `approved_by` text
- `approved_at` timestamp with time zone
- `version` integer not null
- `created_at` timestamp with time zone not null
- `compiled_plan` jsonb
- `compiled_at` timestamp with time zone
- `compiler_version` text
- `source` text not null
- `import_batch_id` uuid
- `result_kind` text
- `display_unit` text
- `display_format` text not null
- `target_value` double precision
- `target_min` double precision
- `target_max` double precision
- `target_direction` text not null
- `comparison_basis` text not null
- `aggregation_window` text not null
- `chart_type` text not null
- `result_unit` text
- `required_signals` text[] not null
- `required_parameters` text[] not null
- `named_formula_slug` text
- `named_formula_version` integer
- `bindings` jsonb not null

## `equipment_class_profile`

- `id` uuid not null
- `slug` text not null
- `version` integer not null
- `name` text not null
- `description` text
- `category` text
- `expected_signals` jsonb not null
- `failure_modes` jsonb not null
- `default_thresholds` jsonb not null
- `status` text not null
- `published_at` timestamp with time zone
- `updated_at` timestamp with time zone not null
- `service_interval_hours` integer
- `source` text not null
- `import_batch_id` uuid

## `equipment_class_sensor_requirement`

- `id` uuid not null
- `class_slug` text not null
- `class_version` integer not null
- `measurement_role` text not null
- `component_scope` text not null
- `criticality` text not null
- `min_count` integer not null
- `canonical_unit` text
- `enables` text[] not null
- `notes` text
- `source` text not null
- `import_batch_id` uuid
- `stale_after_seconds` integer

## `equipment_parameter` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `source_system` text not null
- `external_id` text not null
- `parameter_key` text not null
- `value` double precision
- `unit` text not null
- `source` text not null
- `source_ref` text
- `status` text not null
- `approved_by` text
- `approved_at` timestamp with time zone
- `version` integer not null
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null

## `equipment_placement_event` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `source_system` text not null
- `external_id` text not null
- `from_plant_id` uuid
- `to_plant_id` uuid
- `reason` text
- `actor_user_id` text not null
- `at` timestamp with time zone not null

## `equipment_profile` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `source_system` text not null
- `external_id` text not null
- `equipment_class_slug` text
- `class_version` integer
- `tier` text not null
- `commissioned_at` timestamp with time zone
- `service_interval_hours` integer
- `readiness` jsonb not null
- `updated_by` text
- `updated_at` timestamp with time zone not null
- `origin` text not null
- `status` text not null
- `name` text
- `manufacturer` text
- `model_number` text
- `serial_number` text
- `description` text
- `plant_id` uuid
- `created_by` text

## `equipment_projection` — RLS (forced)

- `id` uuid not null
- `source_system` text not null
- `external_id` text not null
- `tenant_id` text not null
- `payload` jsonb not null
- `source_updated_at` timestamp with time zone
- `synced_at` timestamp with time zone not null
- `checksum` text not null
- `status` text not null
- `name` text
- `class_id` text
- `plant_external_id` text
- `category` text

## `equipment_scenario` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `source_system` text not null
- `external_id` text not null
- `client_scenario_slug` text not null
- `state` text not null
- `parameter_overrides` jsonb not null
- `blockers_at_activation` jsonb not null
- `activated_by` text
- `activated_at` timestamp with time zone
- `state_changed_by` text
- `state_changed_at` timestamp with time zone
- `state_reason` text
- `last_evaluated_at` timestamp with time zone
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null

## `equipment_service_record` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `source_system` text not null
- `external_id` text not null
- `performed_at` timestamp with time zone not null
- `kind` text not null
- `meter_reading` double precision
- `meter_unit` text
- `work_order_id` uuid
- `notes` text
- `recorded_by` text
- `recorded_at` timestamp with time zone not null

## `equipment_shift` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `source_system` text not null
- `external_id` text not null
- `name` text not null
- `start_minute` integer not null
- `end_minute` integer not null
- `days` integer[] not null
- `time_zone` text not null
- `status` text not null
- `scored_through` timestamp with time zone
- `created_by` text
- `updated_by` text
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null
- `arrivals_through` timestamp with time zone

## `equipment_template`

- `id` uuid not null
- `name` text not null
- `category` text
- `manufacturer` text
- `engine_type` text
- `fuel_tank_capacity_liters` double precision
- `service_interval_hours` integer
- `description` text
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null

## `named_formula`

- `id` uuid not null
- `slug` text not null
- `version` integer not null
- `name` text not null
- `description` text
- `category` text
- `expression` text not null
- `inputs` jsonb not null
- `result_dimension` text
- `result_kind` text
- `status` text not null
- `published_at` timestamp with time zone
- `created_by` text
- `updated_at` timestamp with time zone not null
- `compiled_plan` jsonb
- `compiled_at` timestamp with time zone
- `compiler_version` text
- `result_unit` text

## `plant` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `code` text not null
- `name` text not null
- `address` text
- `site_area` text
- `capacity` text
- `project_type` text
- `operational_status` text
- `description` text
- `status` text not null
- `source_system` text
- `external_id` text
- `created_by` text
- `updated_by` text
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null

## `platform_access_log`

- `id` uuid not null
- `at` timestamp with time zone not null
- `actor_user_id` text not null
- `actor_roles` text[] not null
- `tenant_id` text
- `tenant_ids` text[]
- `resource` text not null
- `action` text not null
- `reason` text
- `method` text
- `path` text

## `platform_invitation`

- `id` uuid not null
- `platform_user_id` uuid not null
- `token_hash` text not null
- `expires_at` timestamp with time zone not null
- `consumed_at` timestamp with time zone
- `created_by` text
- `created_at` timestamp with time zone not null

## `platform_session`

- `id` uuid not null
- `platform_user_id` uuid not null
- `token_hash` text not null
- `family` uuid not null
- `expires_at` timestamp with time zone not null
- `rotated_at` timestamp with time zone
- `revoked_at` timestamp with time zone
- `revoked_reason` text
- `user_agent` text
- `created_at` timestamp with time zone not null

## `platform_user`

- `id` uuid not null
- `email` text not null
- `full_name` text not null
- `role` text not null
- `status` text not null
- `password_hash` text
- `failed_attempts` integer not null
- `locked_until` timestamp with time zone
- `suspended_at` timestamp with time zone
- `suspended_reason` text
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null
- `invited_by` text
- `invited_at` timestamp with time zone
- `activated_at` timestamp with time zone

## `prediction` — RLS (forced) — partitioned

- `id` uuid not null
- `occurred_at` timestamp with time zone not null
- `tenant_id` text not null
- `source_system` text not null
- `external_id` text not null
- `client_scenario_slug` text not null
- `severity` text not null
- `risk_score` double precision not null
- `abnormal_count` integer not null
- `high_priority` boolean not null
- `confidence` text not null
- `signals` jsonb not null
- `window_days` integer not null
- `model_ref` text not null
- `model_tier` integer not null
- `source` text not null
- `computed_at` timestamp with time zone not null

## `prediction_baseline` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `source_system` text not null
- `external_id` text not null
- `signal` text not null
- `window_days` integer not null
- `mean` double precision not null
- `stddev` double precision not null
- `sample_count` integer not null
- `coverage_ratio` double precision not null
- `first_sample_at` timestamp with time zone not null
- `last_sample_at` timestamp with time zone not null
- `source` text not null
- `computed_at` timestamp with time zone not null

## `projection_rejection`

- `id` uuid not null
- `source_system` text not null
- `kind` text not null
- `external_id` text
- `reason` text not null
- `payload` jsonb not null
- `created_at` timestamp with time zone not null

## `scenario_activation_event` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `source_system` text not null
- `external_id` text not null
- `client_scenario_slug` text not null
- `action` text not null
- `from_state` text
- `to_state` text not null
- `reason` text
- `blockers` jsonb not null
- `actor_user_id` text not null
- `actor_roles` text[] not null
- `at` timestamp with time zone not null

## `scenario_definition`

- `id` uuid not null
- `slug` text not null
- `version` integer not null
- `equipment_class_slug` text not null
- `name` text not null
- `description` text
- `severity` text not null
- `tier` integer not null
- `required_signals` text[] not null
- `minimum_history_days` integer not null
- `parameters` jsonb not null
- `status` text not null
- `published_at` timestamp with time zone
- `updated_at` timestamp with time zone not null

## `sensor`

- `id` uuid not null
- `sensor_name` text not null
- `category_id` uuid
- `description` text
- `protocol` text
- `parameter_specs` jsonb not null
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null
- `slug` text not null

## `sensor_category`

- `id` uuid not null
- `name` text not null
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null

## `sensor_instance` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `source_system` text not null
- `external_id` text not null
- `sensor_id` uuid not null
- `component_id` text not null
- `position` text
- `serial` text
- `installed_at` timestamp with time zone
- `calibration_requirement` text
- `status` text not null
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null

## `sensor_map_projection` — RLS (forced)

- `id` uuid not null
- `source_system` text not null
- `external_id` text not null
- `tenant_id` text not null
- `payload` jsonb not null
- `source_updated_at` timestamp with time zone
- `synced_at` timestamp with time zone not null
- `checksum` text not null
- `status` text not null
- `imei` text not null
- `signal` text not null
- `sensor_name` text
- `unit` text

## `sensor_role_capability`

- `id` uuid not null
- `sensor_id` uuid not null
- `measurement_role` text not null
- `parameter_key` text
- `canonical_unit` text
- `source` text not null
- `import_batch_id` uuid

## `shift_run` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `shift_id` uuid not null
- `shift_name` text not null
- `source_system` text not null
- `external_id` text not null
- `local_date` text not null
- `window_start` timestamp with time zone not null
- `window_end` timestamp with time zone not null
- `status` text not null
- `detail` text
- `readings` integer not null
- `predictions` integer not null
- `jobs_raised` integer not null
- `alerts_fired` integer not null
- `duration_ms` integer
- `ran_at` timestamp with time zone not null

## `signal_alias`

- `id` uuid not null
- `source_system` text not null
- `alias` text not null
- `canonical` text not null
- `unit` text
- `note` text

## `signal_binding_version` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `source_system` text not null
- `external_id` text not null
- `signal_key` text not null
- `measurement_role` text not null
- `component_id` text not null
- `origin` text not null
- `imei` text
- `channel` text
- `sensor_instance_id` uuid
- `canonical_unit` text not null
- `source_unit` text
- `unit_transform_version` text
- `calibration_version_id` uuid
- `valid_from` timestamp with time zone not null
- `valid_to` timestamp with time zone
- `validity` tstzrange
- `expected_period_seconds` integer
- `freshness_policy` jsonb not null
- `quality_policy` jsonb not null
- `is_primary` boolean not null
- `status` text not null
- `discovered_from` uuid
- `discovered_by` text not null
- `approved_by` text
- `approved_at` timestamp with time zone
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null

## `telemetry_reading` — RLS (forced) — partitioned

- `id` uuid not null
- `tenant_id` text not null
- `imei` text not null
- `signal` text not null
- `value` double precision not null
- `unit` text
- `source_timestamp` timestamp with time zone not null
- `received_at` timestamp with time zone not null
- `source` text not null

## `tenant` — RLS (forced)

- `tenant_id` text not null
- `name` text not null
- `status` text not null
- `plan` text
- `region` text
- `suspended_at` timestamp with time zone
- `suspended_reason` text
- `provisioned_by` text
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null

## `tenant_map`

- `id` uuid not null
- `source_system` text not null
- `external_client_id` text not null
- `tenant_id` text not null
- `display_name` text
- `created_at` timestamp with time zone not null

## `tenant_role` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `slug` text not null
- `name` text not null
- `description` text
- `capabilities` text[] not null
- `scope_shape` text not null
- `is_built_in` boolean not null
- `template_slug` text
- `copied_at` timestamp with time zone
- `updated_by` text
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null
- `allowed_tabs` text[] not null

## `tool_mapping`

- `id` uuid not null
- `tool_name` text not null
- `industry_type` text
- `protocol` text
- `mapped_sensors` jsonb not null
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null

## `user_equipment_access` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `user_id` uuid not null
- `source_system` text not null
- `equipment_external_id` text not null
- `granted_by` text
- `granted_at` timestamp with time zone not null

## `user_invitation` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `user_id` uuid not null
- `token_hash` text not null
- `purpose` text not null
- `expires_at` timestamp with time zone not null
- `consumed_at` timestamp with time zone
- `created_by` text
- `created_at` timestamp with time zone not null

## `user_plant_access` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `user_id` uuid not null
- `granted_by` text
- `granted_at` timestamp with time zone not null
- `plant_id` uuid not null

## `user_security_event` — RLS (forced)

- `id` uuid not null
- `tenant_id` text
- `user_id` uuid
- `email_attempted` text
- `type` text not null
- `detail` text
- `ip_address` text
- `user_agent` text
- `at` timestamp with time zone not null

## `user_session` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `user_id` uuid not null
- `token_hash` text not null
- `family` uuid not null
- `expires_at` timestamp with time zone not null
- `rotated_at` timestamp with time zone
- `revoked_at` timestamp with time zone
- `revoked_reason` text
- `user_agent` text
- `created_at` timestamp with time zone not null

## `utilization_shift` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `shift_id` uuid not null
- `shift_name` text not null
- `source_system` text not null
- `external_id` text not null
- `plant_id` uuid
- `equipment_class_slug` text
- `local_date` text not null
- `window_start` timestamp with time zone not null
- `window_end` timestamp with time zone not null
- `total_seconds` double precision not null
- `productive_seconds` double precision not null
- `idle_seconds` double precision not null
- `running_unclassified_seconds` double precision not null
- `off_seconds` double precision not null
- `unknown_seconds` double precision not null
- `engine_on_seconds` double precision not null
- `carry_seconds` double precision not null
- `coverage` double precision not null
- `utilization_rate` double precision
- `productive_rate` double precision
- `idle_rate` double precision
- `runtime_delta` double precision
- `runtime_unit` text
- `runtime_counter_reset` boolean not null
- `samples` integer not null
- `signals_present` text[] not null
- `computed_at` timestamp with time zone not null

## `work_order` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `reference` text not null
- `source_system` text not null
- `external_id` text not null
- `title` text not null
- `description` text
- `status` text not null
- `priority` text not null
- `assigned_to_user_id` uuid
- `prediction_id` uuid
- `due_at` timestamp with time zone
- `started_at` timestamp with time zone
- `ended_at` timestamp with time zone
- `resolution` text
- `raised_by` text not null
- `created_at` timestamp with time zone not null
- `updated_at` timestamp with time zone not null
- `origin` text not null
- `raised_for_scenario` text

## `work_order_counter` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `next_number` integer not null

## `work_order_event` — RLS (forced)

- `id` uuid not null
- `tenant_id` text not null
- `work_order_id` uuid not null
- `kind` text not null
- `from_status` text
- `to_status` text
- `from_assignee` uuid
- `to_assignee` uuid
- `note` text
- `actor_user_id` text not null
- `at` timestamp with time zone not null


<!-- regenerate with:
SELECT '## `' || c.relname || '`' ||
       CASE WHEN c.relrowsecurity THEN ' — RLS' || CASE WHEN c.relforcerowsecurity THEN ' (forced)' ELSE '' END ELSE '' END ||
       CASE WHEN c.relkind = 'p' THEN ' — partitioned' ELSE '' END || E'\n\n' ||
       string_agg('- `' || a.attname || '` ' || format_type(a.atttypid, a.atttypmod) ||
                  CASE WHEN a.attnotnull THEN ' not null' ELSE '' END, E'\n' ORDER BY a.attnum) || E'\n'
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND c.relname <> 'migrations'
GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relkind
ORDER BY c.relname;
-->
