# Things Alive AI coding guide
## Start here
21 September 2026 • Backend prediction GenAI MCP and visual workflow scope

The practical way to reduce wasted credits is to stop redesigning the product inside each coding conversation. Keep product decisions in files, implement one testable outcome at a time, and let tests provide routine feedback. Short prompts alone do not guarantee lower cost: repeated mistakes, large context and unnecessary agent/tool loops can cost more than a well-specified task.

There are two separate costs: the coding assistant used to build Things Alive, and the AI calls made by the finished platform. This kit addresses both. It does not claim a specific credit saving or validated current implementation.

## How to use these files

Place this kit under docs/ai in the BACKEND repository, alongside copies of the existing Backend Technical Specification, Backend Delivery Plan and Visual Workflow Backend Addendum. Do this once. The manual UI team receives the API schemas/examples, not a separate implementation of business rules.

1. Start with Prompt 1 in PROMPTS.md. It inventories the repository and creates a reusable map; it does not rebuild existing features.
2. Review only the architecture conflicts or missing domain facts it identifies. Ordinary implementation choices stay with the agent.
3. Use Prompt 2 to turn the next ready work package into one small task packet, or use the provided starter packet.
4. Use Prompt 3 to implement that packet. The agent completes code, applicable migrations, actual boundary tests and task evidence together.
5. Use Prompt 4 when a test or bug fails. Keep the task active; do not start a broad redesign.
6. At a milestone, use Prompt 5 for a focused independent review. Do not commission a full repository review after every small edit.
7. Start a fresh coding conversation at a completed task boundary using Prompt 6 and saved state. Do not paste the whole chat history.

The original Word files stay version 1.0. The Markdown visual-workflow addendum extends their alert/agent scope to version 1.1. No UI or backend code is implemented by this kit.

## Product rules every coding task inherits
G01 Multi-tenant isolation applies to HTTP, background jobs, MCP, AI retrieval, sockets, files and exports. Resolve authority on the server; never trust an arbitrary tenant ID.
G02 Master Admin authors global published equipment, signal, scenario, formula, widget and workflow templates. Client Super Admin configures own assets, users, activations, pins and permitted overrides, not global definitions.
G03 Operator has scoped views, workflow drafts and permitted work-order actions; no team management/device control. Viewer/assisted access is read-only. Delegated Alert Admin may publish approved alert flows only within assigned scope. No implicit general admin rights.
G04 Separate requested activation from execution readiness. Onboarding returns Operational, Analytical and Prediction groups with Ready/Pending/Blocked reasons. Missing/uncalibrated/stale data never looks healthy.
G05 Existing raw telemetry remains upstream; 2.0 reads it through a bounded read-only adapter. 2.0 owns identity, sites/equipment and application state. New device registration is not proof it is commissioned.
G06 Prediction scheduling is shift-based where configured, with separately defined operational cadence. Preserve event and arrival clocks, late revisions, device ownership history and one current outcome per logical window.
G07 Rules and scoring are deterministic code. Tier 0/1 first. No fabricated probabilities, RUL, OEM limits or labels. Higher tiers require independent domain-approved evidence.
G08 Graph UI is an input/view. Server stores, validates, versions and executes workflows even with the browser closed. Graph layout is separate from execution semantics.
G09 AI generates proposals and explanations. Normal services enforce action permissions, exact approval, resource versions and idempotency. Report success only from actual persisted results.
G10 Replay/simulation shares calculation code but has a separate run namespace. It cannot send production notifications, create live work, affect live baselines or approve models.
G11 Accepted recommendations become traceable Action Items/work. Auto-create and external auto-dispatch are separate explicit opt-ins with limits and a kill switch. Retries cannot duplicate work/SAP orders.
G12 UI is manually developed. Supply OpenAPI, example payloads, error/permission/freshness states and run-event contracts; do not implement React components.
G13 Definition/model versions and evidence are immutable. Customer changes do not silently alter shared catalogs or published running workflows.
G14 Follow repository instructions and required checks. Do not skip security, API-boundary, migration or data-quality tests to shorten a response. Never put secrets, production customer data or unrestricted logs into chat.

## Context and state files
Keep these short and in source control. They are normal project files, not dependent on one AI vendor's memory feature.

- REPO_MAP.md: actual module paths, runtime/framework versions, test commands and existing feature locations. Target one page; update only affected entries.
- DECISIONS.md: settled architecture and the reason, with requirement ID. Record a real change once; avoid reopening it in every conversation.
- STATUS.md: task ID, status, commit/files, tests actually run, remaining blocker and next task. Link long logs instead of copying them.
- tasks/TASK-ID.md: outcome, dependencies, relevant requirement IDs/spec sections, allowed scope, API/data changes and acceptance tests.
- COVERAGE.md: G01–G14 plus Master M01–M11 and Client C01–C10 mapped to tasks and evidence. A row with no proof remains unverified.

Existing repository instruction files take precedence over this workflow guidance. Do not replace them or add a huge project instruction file that forces every future request to load the full specification.

## Rules that reduce avoidable coding consumption
Use one implementation agent by default. Delegate only independent, bounded work after contracts stabilize. Use a separate reviewer at security/architecture/model milestones or when a change warrants it; parallel agents reading the same whole repository duplicate work.

Read the brief, current task, relevant code and specified sections. Search filenames/symbols before opening large files. Expand context when necessary; never force a tiny context limit that causes guessing. Avoid re-uploading all five source documents for every task.

Have the agent report a small plan, then work. Prefer focused edits over unrelated rewrites. Run targeted tests first and required CI checks before completion. Do not rerun unchanged successful suites repeatedly without a reason.

Record concrete decisions and small progress summaries. Request short final reports, not explanations of every source file. Do not ask an agent to self-certify it has covered everything; use the coverage matrix and independent tests.

Use stronger reasoning for architecture/security/data-model/prediction validation, and routine settings for narrowly specified transformations if the selected tool supports that choice. Measure actual usage per accepted task; no model or session configuration guarantees a fixed saving.

## Keep the finished platform economical too
Do not invoke an LLM for every telemetry reading, schedule tick, threshold check, formula, authorization decision or prediction arithmetic. Invoke AI when a user asks, an onboarding ambiguity needs help, or a meaningful new condition needs an explanation.

Deduplicate explanations by condition episode. Cache only within tenant and effective permission scope, keyed by source/config/model/prompt versions with freshness and invalidation. Bound retrieved evidence, steps, time, tokens, tool calls and retries; disclose partial results if a budget is exhausted.

MCP is the controlled tool interface, not the reasoning engine or a substitute for authorization. Expose small tools such as get_asset_readiness, get_prediction_evidence and propose_work_order backed by the same domain services. A write tool still requires a valid approved action and server-side checks. Tool metadata is not permission. Pin the supported MCP/SDK version and transport; verify authentication and audience/scopes for that implementation. No generic execute_sql or execute_shell for tenant agents.

References for MCP contracts: https://modelcontextprotocol.io/specification/latest/server/tools and https://modelcontextprotocol.io/specification/latest/basic/authorization (reviewed 21 September 2026).

## When human input is genuinely needed
Ask only for a fact that cannot safely be inferred: confirmed sensor unit/OEM limit, intended data retention, actual source connection, SAP service or model acceptance target. Present the concrete blocker, a recommendation and the exact task it blocks. Continue independent authorized work. Missing facts must not be replaced with made-up thresholds, data or completion claims.
