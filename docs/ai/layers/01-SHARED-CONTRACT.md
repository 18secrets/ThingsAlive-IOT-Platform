# Shared implementation contract — include with every layer prompt

> **Read with DECISIONS.md.** Section 2A below is overridden by D04: this platform copies
> catalog content into an account on grant, and the copy becomes the client's. See that
> entry before implementing an intelligence profile as references.

## 1. Conventions and authority

NestJS owns API/auth/domain state; Python workers own calculation, embedding and retrieval inference as appropriate. Existing equivalent boundaries take precedence over creating duplicate services. Use JSON Schema/OpenAPI contracts between languages. Tenant IDs, actor IDs, capabilities and allowed asset scopes originate in authenticated server context, never from prompt text or caller-supplied role fields. All operational writes are tenant-scoped and audited. Workers use scoped service identities.

UUID IDs; UTC RFC3339 timestamps; half-open validity/window intervals `[start,end)`; numeric values finite; explicit canonical units; immutable published versions. JSON examples using mnemonic IDs are illustrative and must be converted to valid fixture UUIDs. Every tenant FK includes tenant_id. Optimistic updates require If-Match version. Errors: `{code,message,field_path,request_id,retryable,details}`; details must not reveal other tenants. Hidden resources return 404, authenticated missing capabilities 403, invalid input 422, conflict 409, unavailable dependency 503. Async jobs return 202 with job_id and status_url. Mutations require scoped idempotency keys with payload hashes; same key/different payload returns 409.

Tenant context is transaction-local. The DB application role must not be an owner/superuser or have BYPASSRLS. Authorization also enforces asset scope and field sensitivity; RLS alone is insufficient. Platform library publishing uses a separate explicit capability, not implicit access to all customer documents. Assisted customer sessions are read-only.

## 2. Equipment-to-signal graph

```text
Tenant → Site → Equipment → optional component Equipment
Equipment ← DeviceBinding → Device → Channel
Equipment ← SensorInstance → SensorDefinitionVersion
SignalBinding → Equipment + SignalDefinitionVersion + source Channel
SignalBinding → optional SensorInstance + calibration + transform + validity
Observation → SignalBindingVersion + event time + source identity
VirtualMeasureBinding → FormulaVersion + ordered input SignalBindings
KnowledgeApplicability → DocumentVersion + equipment/signal/fault applicability
```

An ECU/PLC/logger is a source/transport device, not a sensor or the equipment itself. One channel may carry a computed ECU value with unknown physical transducer; do not create a fake physical sensor. One sensor may expose several signals. A virtual measure has no physical sensor serial number. Component membership is acyclic. A separate typed topology relation models supplies_power_to, backed_up_by and connected_to; it must not be confused with component containment or an executable workflow. Circular electrical topology may be legitimate but is never inferred to be an executable calculation cycle.

Required entities (beyond id, tenant/version/audit metadata where applicable):

| Entity | Minimum fields and invariants |
|---|---|
| equipment_class_version | slug, parent_class, sensing_domains, expected_signal_roles, published_status, provenance |
| equipment | site_id, parent_equipment_id?, class_version_id, name, code, make?, model?, serial?, nameplate, lifecycle, timezone; make/model optional |
| equipment_relation | from_equipment_id, to_equipment_id, relation_type, validity, provenance; both within tenant |
| device | product_definition_version, serial, protocol, firmware_version?, connectivity_status; no network secrets in context |
| device_binding | device_id, equipment_id, ownership_epoch, valid_from/to; no ambiguous overlapping ownership |
| channel | device_id, protocol_address, data_type, source_unit, scaling, sample_period_ms?, decoder_version; preserve protocol mapping provenance |
| sensor_definition_version | quantity_kind, compatible_units, measurement_range, resolution?, accuracy_spec?, calibration_methods, source; measurement range is not an alarm threshold |
| sensor_instance | equipment_id, definition_version_id, position/component, serial?, install_date?, calibration_requirement, status |
| signal_definition_version | stable_key, quantity_kind, canonical_unit, value_type, enum_values?, valid_aggregation_methods, description |
| signal_binding_version | equipment_id, signal_definition_version_id, sensor_instance_id?, channel_id?, origin=physical/ecu_derived/virtual, measurement_role, component_id?, unit_transform_version, calibration_version?, validity, expected_period, freshness_policy, quality_policy, readiness |
| calibration_version | method=identity/two_point/multipoint, raw/reference points and units, performed/effective/expiry times, certificate_ref?, uncertainty?, approved_by; preserve approved factory/ECU no-calibration-required basis |
| observation | binding_version_id, event_time, received_time, source_reading_id, sequence?, boot_id?, raw_value/unit, canonical_value/unit, quality_flags, context, run_id?, ownership_epoch, transform/calibration refs |
| formula_version | formula_key, typed input roles/units, output role/unit, executable allowlisted implementation ref or validated AST, validity envelope, parameter schema/source, dependency policy, status |
| equipment_model_binding | equipment_id, definition_version, input_binding_ids by role, approved_parameter_set_version, readiness, enabled_requested, execution_status |

Typed transform order: decode raw channel → approved engineering scale/offset → unit conversion → optional residual calibration explicitly defined in canonical units. No undocumented double scaling. A calibration defined at raw level must be compiled into an unambiguous versioned pipeline, not applied again downstream. Tests cover offsets such as Fahrenheit/Celsius. Sensor engineering min/max, plausible physical range, expected operational range and alarm threshold are different fields.

Canonical units are machine-readable codes: `degC`, `kW`, `kWh`, `V`, `A`, `L`, `L/h`, `h`, `1`, `%`, `kg`. Add an allowlisted conversion registry and dimensional checks; do not rely on model-generated conversion code. Power, energy and apparent power are different quantities. Counter reset/rollover policy is mandatory before computing rates. Reject silent aggregation of temperatures across unrelated components and double counting through composite equipment.

## 2A. Equipment intelligence profile and recommendation policy

> **Overridden in part by D04.** The paragraph below says not to duplicate authoritative
> values into an editable profile. This platform copies catalog content on grant and the
> copy becomes the client's, with provenance by content checksum and upgrades adopted
> explicitly rather than propagated. Implement the copy model; read the rest of this
> section as written.

Create a versioned `equipment_intelligence_profile` linking equipment_id, equipment_revision, component_scope, signal_binding_versions, operating_regime_policy_version, calculation_bindings, rule_bindings, knowledge_applicability_refs, recommendation_policy_bindings and approved_ml_bindings. Published library templates propose this profile; customer instances bind actual signals and approved parameters. Do not duplicate authoritative values into an independently editable profile. Persist versioned references and expose a resolved projection with an as-of timestamp.

Each layer reports availability=ready/blocked/not_configured/not_available, reasons[], missing_inputs[], prerequisite_refs[], validation_state, execution_enabled and last_evaluated_at. Detailed readiness reasons from P04 remain intact. Availability is not equipment health or predictive confidence. No blanket 'AI enabled' flag may imply every layer works. Unknown operating regime blocks methods that require a known regime; do not mix startup, idle and loaded baselines.

The profile covers data quality, physics calculations, physics forecasts, approved rules, statistical anomalies, recommendation AI, predictive ML and permitted agent actions. Predictive ML without an approved model is not_available. Physics forecasts require identified/validated parameters. Recommendations require usable evidence and applicable procedures. Changes to sensors, calibration, templates, parameters, source documents or model approval trigger profile reevaluation; authorization changes invalidate user-specific action projections.

Create immutable `recommendation_policy_version` with applicable equipment/component classes, condition/scenario IDs, required evidence/quality, approved source references, diagnostic step templates, priority rule, permitted action types, simulation_definition_ref?, escalation criteria and reviewer/status. The model may explain an approved recommendation or draft a novel suggestion for review; it cannot silently turn a suggestion into an approved policy or physical diagnosis.

Persist recommendations with equipment/profile/policy versions, condition_episode_id, evidence_refs, observation_vs_hypothesis, aim, expected_outcome, missing_information, priority plus policy-based rationale, source citations, simulation_available plus definition/readiness reference, proposed_action, required_capability and lifecycle. Priority follows approved severity/criticality policy, not unvalidated model confidence. Deduplicate by equipment, episode and policy version; evidence changes produce revisions. Lifecycle includes proposed, accepted, in_progress, resolved, dismissed and superseded; outcome verification is distinct from merely closing a work order. Model-generated speculation never becomes a confirmed training label automatically.

## 3. Runtime context and calculations

`EquipmentContextV1`: see `docs/ai/contracts/equipment-context.v1.schema.json`, which is the
authoritative form. The illustrative shape:

```json
{
  "schema_version": "1",
  "context_id": "UUID",
  "tenant_id": "SERVER_UUID",
  "equipment_id": "UUID",
  "as_of": "2026-09-21T12:00:00Z",
  "window": {"start": "2026-09-21T11:45:00Z", "end": "2026-09-21T12:00:00Z"},
  "mode": "live",
  "scope_revision": 7,
  "equipment": {"class_version_id": "UUID", "make": null, "model": null, "revision": 3},
  "signals": [],
  "calculations": [],
  "active_events": [],
  "missing_inputs": [],
  "knowledge_filters": {"equipment_class_ids": [], "signal_keys": [], "fault_codes": []},
  "provenance": {"binding_revision": 2, "policy_versions": [], "snapshot_hash": "SHA256"}
}
```

Signal entries: binding_id/version, signal_key, measurement_role, component_id?, origin, value|null, unit, aggregate_method, event_time, received_time, sample_count, coverage_kind, coverage, quality_flags, calibration_state, freshness_state. Never treat missing/stale as zero or healthy. Context is a bounded aggregate snapshot, not all packets or an unrestricted database dump. Scope revision is a reference to a server-side authorization snapshot, not a capability grant.

`CalculationResultV1`: result_id, equipment_id, definition_version, context/live-or-simulation, window, input_bindings/versions, parameter_set_version, source_reading_range_hash, value|null, unit, method, status=ready/partial/pending/blocked/error, reasons[], assumptions[], limitations[], computed_at, source_as_of, failure_probability=null unless approved probability model, estimate_kind, evidence_refs[]. Readiness is separate from anomaly severity. All simulation results have run_id and cannot become live evidence automatically.

Examples: genset coolant temperature → channel binding → degC series → approved-limit episode → evidence; inverter DC/AC power → two synchronized bindings → virtual efficiency → cited operating explanation. Temperature alone cannot calculate engine efficiency. Formula applicability requires actual bindings and approved parameters, not just equipment class/name.

## 4. Knowledge and vector contracts

Documents are untrusted reference data, including uploaded prompts. No extracted text can override tool policy, authorization or system instructions.

| Entity | Required fields |
|---|---|
| knowledge_document | owner_kind=platform/tenant, tenant_id nullable only for platform, source_type, title, language, classification, access_scope=tenant/site/asset/global_published, lifecycle, retention_policy |
| document_version | content_sha256, source_object_key, MIME, byte_size, revision, issuer, publication_date?, effective_from/to?, ingestion_status, review_status, supersedes_id?, parser/OCR versions, extraction_quality |
| knowledge_applicability | document_version_id, equipment_class_version?, make?, model?, firmware_range?, serial_range?, signal_key?, fault_code?, component_role?; explicit unknowns |
| knowledge_grant | document_version_id, tenant_id, effective/expiry, revoked_at; global publication can use an explicit all-active-tenants entitlement policy |
| knowledge_scope | document_version_id, tenant_id, site_id? or equipment_id?; tenant-wide requires explicit scope; linked records never broaden scope |
| chunk | document_version_id, ordinal, body, heading_path, page_start/end?, table/cell locators?, source_offsets, context_prefix, prefix_provenance, chunk_hash, review flags |
| embedding_profile | model_id, immutable_revision, dimension, tokenizer_version, normalization, distance, query_prefix, language, chunker_version, lifecycle |
| chunk_embedding | chunk_id, profile_id, vector, input_hash, indexed_at; unique(chunk_id,profile_id,input_hash) |
| index_generation | profile_id, corpus watermark, status=building/validated/active/retired, validation_report, activated_at |

Visibility requires ALL: principal has read capability; tenant/asset scope permits the selected equipment; document is published/current/not deleted; owner entitlement/grant is active; document scope includes the equipment/request; applicability matches or is explicitly generic. Explicit make/model/firmware mismatches are excluded. Unknown applicability may support labelled generic advice, never model-specific limits. The same predicate applies to lexical/vector branches, parent chunk expansion, reranking, citation downloads and caches. No app-side filtering after unauthorized text has entered the model.

`RetrievalHitV1`: citation_id, document_version_id, chunk_id, title, issuer, locators, text_excerpt, source_hash, applicability=exact/class/generic, relevance_rank, retrieval_methods[], approval/effective metadata. Relevance scores are not factual confidence. Generated prefixes aid search but cannot be cited as OEM source text.

## 5. Answers and actions

`GroundedAnswerV1`: answer_id, context_id, status=answered/partial/needs_input/insufficient_evidence/unavailable, summary, observations[{claim,evidence_refs}], hypotheses[{claim,evidence_refs,limitations}], next_steps[{aim,expected_outcome,required_capability,simulation_available}], citations[], missing_inputs[], as_of, limitations[], proposal_ids[]. Numeric current-condition claims must point to structured calculation/reading evidence; procedural claims to original source locators. A suspected cause is not a confirmed diagnosis. Do not expose hidden chain-of-thought; return concise evidence-based explanations.

Proposal: tenant/actor from server, action type, exact typed payload, target versions, evidence refs/hash, aim/outcome, expiry, permissions required, idempotency key, proposal_hash. Authorized human confirmation rechecks scope, versions and evidence freshness. Validation, simulation and draft save are distinct from publish/execute. LLM and MCP have no approval bypass.

## 6. Role rules

Platform Master Admin publishes shared catalog/documents/templates within its capabilities; no implicit customer private-data access. Client Super Admin manages own tenant and instantiates published definitions. C-suite maps to that tier for now. Operator reads assigned assets, drafts rules and creates permitted work orders; no team administration/device control. Alert Admin publishes approved alert workflows only in explicitly delegated scope. Viewer and assisted sessions are read-only. Agents use the caller's effective capabilities and return explicit authorization failures.

> In this repository, roles are rows a client owns and can rename, and capabilities are
> code. Read the role names above as capability bundles rather than as literal role slugs.
> See D03.

## 7. Defaults are tunable starting policies, not measured guarantees

- Document upload: 25 MiB, PDF/DOCX/TXT first; 500 extracted pages and extraction timeout; oversized files require an explicit batch path. No macro execution or arbitrary remote fetch.
- Retrieval: top 30 semantic + top 30 lexical candidates; exact identifier matches included; RRF constant 60; deduplicate and send at most 8 chunks. Maximum 4,000 generator-token evidence budget plus 1,500 context tokens. Profile tokenizer governs embedding limits separately.
- RAG generation: one answer call, max 1,200 output tokens; no agent swarm. Optional reranker/context-generation disabled initially. Retry transient read failures at most twice within deadline; never unbounded retries or silent duplicate mutations.
- Interactive deadline: 30 seconds; return explicit partial/unavailable on dependency timeout. Tune with real workload; do not claim latency achieved.
- No per-packet LLM invocation. Cache stable approved knowledge using tenant/scope revision, corpus generation, profile and query/context hashes; never reuse another tenant's answer. Fresh readings and revocations invalidate applicable caches.

## 8. Test fixture minimum

Two tenants with identical asset names and conflicting model manuals; one ECU-connected genset, one manually instrumented inverter, one composite machine with duplicate temperature roles; missing calibration; stale telemetry; unknown make/model; a revoked global grant; a malicious document; changed signal mapping; one simulated incident; one real labelled service event fixture. All fixtures are explicitly synthetic. Use them across layers so end-to-end behavior is repeatable.
