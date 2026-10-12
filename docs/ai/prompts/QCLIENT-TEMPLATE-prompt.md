# QCLIENT-TEMPLATE — a client's own equipment templates, onboarding fields only

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Status: ready.** §7 answered 2026-10-12: the user accepted the recommendation on all five.

**Branch:** `feature/client-equipment-templates`, off `main`.

Drafted at the user's instruction (2026-10-12) after checking the client's Equipment
Templates screen against the `equipment-template` module. Scope set by the user:
**onboarding fields only.**

---

## 0. Why

`ClientEquipmentTemplateView` promises a client "full CRUD, invisible to Master Admin and
every other client". Today that lives in the browser's `localStorage`
(`ta_client_equipment_templates`, `App.tsx`): per browser, lost when storage is cleared,
and never seen by the server.

The backend's `equipment_template` cannot hold it:

- it is global — no `tenant_id`, no row-level security, "no tenant" by design (its entity
  comment);
- writing needs `equipment-template.write`, Master Admin only. Granting it to clients would
  put a client's template in the shared table, readable by every other client.

So client templates get their own table, the way the catalog already splits platform
content (`catalog`) from the client's own (`my-catalog`).

## 1. What a client template is

The same onboarding fields as Master Admin's, nothing more:

| field | |
|---|---|
| `name` | required, not blank |
| `category` | free text, as on the master template |
| `manufacturer`, `engine_type` | free text |
| `fuel_tank_capacity_liters` | positive, or null |
| `service_interval_hours` | positive whole number, or null |
| `description` | free text |

**Not here: alert rules, KPI formulas, predictive rules, attached sensors.** The template
detail page attaches all four in `localStorage` today. In the backend they already have a
home that actually runs — the client's copy of an equipment class (`my-catalog`), which the
alert engine and the KPI evaluator read. A second place to define a KPI, which nothing
evaluates, would be a place for a customer's work to silently do nothing. Saying so is part
of this task's report, so the UI team knows those panels need re-pointing rather than
wiring.

Like Master Admin's, a client template is **onboarding convenience**: its values are
copied into an equipment record when one is created, and nothing references a template
afterwards. Editing or deleting one changes no machine.

## 2. The table

`client_equipment_template`, tenant-owned: `tenant_id`, the §1 fields, `copied_from_id`
(provenance only, §7 Q3), `created_by`, `updated_by`, timestamps.

- `tenant_isolation` row-level security, `FORCE`d, as every tenant table. `rls-coverage`
  picks it up from the entity on its own.
- The positivity rules in §1 are CHECK constraints. A negative tank capacity would reach the
  usable-fuel runtime calculation as a number.
- Names unique per tenant, case-insensitive: a unique index on `(tenant_id, lower(name))`.

`equipment_template` is not altered.

## 3. Endpoints

| | | capability |
|---|---|---|
| `GET /api/v1/my-equipment-templates` | this tenant's templates | `equipment-template.read` |
| `POST /api/v1/my-equipment-templates` | create | `equipment.write` |
| `POST /api/v1/my-equipment-templates/from/:masterId` | copy a Master Admin template's fields into a new one of the client's (provenance only) | `equipment.write` |
| `PATCH /api/v1/my-equipment-templates/:id` | edit; omitted fields unchanged (the master service's own `undefined` trap applies) | `equipment.write` |
| `DELETE /api/v1/my-equipment-templates/:id` | delete — nothing references a template | `equipment.write` |

`GET /equipment-templates` (Master Admin's library) is unchanged and stays read-only to
clients. Another tenant's template is a 404, not a 403.

No platform role reads or writes these through an ordinary route — a client's own
templates reached from Things Alive go through the audited cross-tenant path, as
`client-catalog` already does.

## 4. Tests

`test/client-equipment-template.spec.ts`:

- Tenant B cannot list, read, edit, copy over or delete tenant A's template — through the
  service, and refused by RLS with the service bypassed.
- A negative capacity, a zero or fractional service interval and a blank name are refused
  **by the database**, attempted as `ta_app`.
- Copy from master: fields copied, `copied_from_id` set; editing the master afterwards does
  not change the copy, and editing the copy does not change the master.
- PATCH with one field leaves the others as they were.
- A platform role is refused on every route.
- A client caller is still refused on `POST /equipment-templates` (Master Admin's), so
  nothing here widened the shared table.
- Down path named with `undoMigrationNamed`.

## 5. Out of scope

- Alert rules, KPI formulas, predictive rules and sensors on templates (§1).
- Importing what clients already keep in `localStorage`. That data is in browsers, not on
  the server; offering an upload is the UI's call, and would use `POST` as any client would.
- Wiring templates into the Add Equipment form. The form's pre-fill reads whatever list it
  is given; the UI team supplies both lists.
- Any change under `frontend/`, and any change to `equipment_template`.

## 6. Done when

`npm run build` and `npm run test:db` green; `test:db` before and after on a worktree off
`origin/main`, naming the base SHA; full suite on the branch, including `rls-coverage`.
Migration timestamp above `main`'s newest. OpenAPI tags and an example payload per route.
The report names the four template-detail panels the UI must re-point to `my-catalog`.

## 7. Decisions (answered 2026-10-12 — the recommendation, each time)

1. **Which capability writes?** Recommendation: `equipment.write` for writes (super admin,
   admin, and the site-manager template hold it — the people who add equipment, which is
   what templates are for) and the existing `equipment-template.read` for `GET`. The
   alternative, `client-catalog.write`, is super admin alone, which would stop a site
   manager keeping templates for the machines they onboard.
2. **Does a site-scoped role see every template in the account, or only some?**
   Recommendation: every one. A template names a kind of machine, not a machine at a site;
   narrowing it by plant would need a plant column nobody has asked for.
3. **Copy from master: provenance only, or kept in sync?** Recommendation: provenance only
   — `copied_from_id` records where it came from and nothing more. A copy that changes when
   Master Admin edits the original is not the client's, and G13's rule is that customer-
   facing copies do not shift underneath them. If the master is later edited, the copy
   stays as it was.
4. **Unique names per tenant?** Recommendation: yes, case-insensitive
   (`(tenant_id, lower(name))`). Templates are picked from a list by name; two called
   "CAT 320" are two the person cannot tell apart. Master and client names may collide —
   they are shown in separate lists.
5. **Delete, or archive?** Recommendation: delete. Nothing references a template after it
   is copied into equipment (§1), so there is no history to protect, and an archive state
   would be a lifecycle this table was designed not to have.

## Recorded at implementation (2026-10-12)

- Platform roles are refused in the service, not only by the capability gate: Master Admin
  holds both `equipment.write` and `equipment-template.read` in the static table, so the
  gate alone would have let it in. Tested at the service and over HTTP.
- `equipment-template.read` is Master Admin's alone in the static table; tenant users get it
  from their role rows (the three role templates carry it). A client role edited to drop it
  loses the list along with Master Admin's library. Same capability, same answer.
- `copied_from_id` is not a foreign key. Master Admin's template may be edited or go away;
  the client's copy is theirs regardless.
- A second copy of the same master needs its own name (the unique index); the copy route
  takes an optional `name` for that.
- A fractional `serviceIntervalHours` is refused by the DTO (`@IsInt`) with a 400, and by
  the database's integer column if anything gets past it.
- **For the UI team:** the template detail page's sensors, alert rules, KPI formulas and
  predictive rules panels (`TemplateAlertRulesPanel`, `TemplateKpiFormulasPanel`,
  `TemplatePredictiveRulesPanel`, and the sensor links kept in
  `ta_client_template_sensor_links`) have no backend here by design. Alerts and KPIs that
  run belong on the client's class copy under `/my-catalog`.
