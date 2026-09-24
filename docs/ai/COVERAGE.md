# Coverage

G01–G14 against actual modules and evidence. A row with no proof stays **unverified** —
"the code exists" is not proof, a passing test at the real boundary is.

| Rule | State | Where | Evidence, or what is missing |
|---|---|---|---|
| G01 multi-tenant isolation across HTTP, jobs, MCP, retrieval, sockets, files, exports | **partial** | `src/auth`, `src/scope`, RLS | `auth-matrix.spec.ts` derives routes from the live router; `rls-coverage.spec.ts` derives protected tables from entity metadata; both run as `ta_app`. **MCP, retrieval, sockets, files and exports do not exist yet**, so those surfaces are unproven by absence rather than by test |
| G02 Master Admin authors global templates; Super Admin configures own | **verified** | `src/catalog`, `src/client-catalog` | `catalog.write` is platform-only; `client-catalog.write` is super admin only and no platform role appears in it. `client-catalog.spec.ts` covers the copy and the refusal |
| G03 Operator scoped; viewer/assisted read-only; delegated Alert Admin scoped | **partial** | `src/auth/capabilities.ts` | `action.work` vs `action.assign` split is tested. **Assisted access does not exist** (Q24). Delegated Alert Admin has no publish scope yet — needs Q18 |
| G04 requested activation separate from execution readiness; groups with reasons | **partial** | `src/activation` | Blockers are reason codes with specifics, and an activation records unresolved blockers at the time it was turned on. **The Operational/Analytical/Prediction grouping is not implemented** — the shipped buckets are `availableNow`/`availableLater`/`notApplicable`, retired by D07 |
| G05 raw telemetry stays upstream; bounded read-only adapter | **verified by construction** | `src/legacy`, `src/projection` | No write path to the 1.0 database exists anywhere. Add an explicit assertion in Q08S rather than relying on absence |
| G06 shift-based scheduling; event and arrival clocks; late revisions; one current outcome | **verified** | `src/shift`, `src/telemetry` | `shift-runner.spec.ts`, `shift-window.spec.ts`, late-arrival rewind and sweep, high-watermark plus bounded overlap, device ownership history in `device_inventory_event` |
| G07 deterministic rules and scoring; Tier 0/1 first; no fabricated probabilities | **verified** | `src/prediction`, `src/alert` | Influence model scores against physics rather than the machine's own past; `severity.spec.ts` refuses to guess an unmapped value; catalog content is loaded as draft with every threshold traced to a named source |
| G08 server stores, validates, versions and executes workflows | **missing** | — | No workflow engine. Alert rules are rows with typed triggers, not a node graph. Q18/Q19, blocked on the missing addendum |
| G09 AI proposes; normal services enforce permission, approval, versions, idempotency | **not started** | — | Nothing AI-shaped exists. The enforcement half is present and tested |
| G10 replay/simulation shares code, separate run namespace, no live effects | **partial** | `src/activation` | Preview/simulation exists for activation. No general run namespace, no `run_id` on results |
| G11 accepted recommendations become traceable work; auto-dispatch opt-in with kill switch | **partial** | `src/work` | Work orders raise automatically with a person in the loop; `work-order.spec.ts` covers both levels. No recommendation records, no external dispatch, no kill switch |
| G12 UI manual; supply OpenAPI, examples, error/permission/freshness states | **partial** | Swagger annotations throughout | Routes are annotated. No exported OpenAPI artifact or fixture set for the UI team |
| G13 definition and model versions immutable; customer changes do not alter shared catalogs | **verified** | `src/catalog` | `(slug, version)` unique; publishing forks a new version; re-granting never overwrites a copy |
| G14 follow repository checks; no skipped security, boundary, migration or data-quality tests | **verified** | CI + `test/` | 42 suites, 674 tests, nothing skipped, against a real Postgres. `migration.spec.ts` tests down paths; `request-validation.spec.ts` is a derived guard that catches the keyed-vs-whole `@Body` bug class |

## Portal ledger

Unverified until an endpoint, a test and a commit are named. Master Admin M01–M11 and
Client C01–C10 map to Q packages in `TASK-QUEUE.md`; the backend for M08 Widget Catalog,
M09 Dashboard Templates, M10 Composition Proposals, M07 Integrations and M02/M11 Assisted
Access does not exist yet, and neither does any Knowledge screen's backend before Q21A.
