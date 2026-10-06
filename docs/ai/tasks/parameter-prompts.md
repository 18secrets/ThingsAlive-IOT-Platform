# QPARAM1 — tenant parameters and cost profiles

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/parameter-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/tenant-parameters`

**Stream B.** Do not touch `template-schema.ts`, `CLASS_CONTENT_INVENTORY`, or anything under
`src/catalog-import/` — Stream A owns those. Assign the migration timestamp **at rebase
time**, immediately before opening the MR.

---

## 0. The four open questions, answered

These supersede anything in the register or D31.

**1. Four levels, not three.** D37 replaces D31's sketch:

```
client  →  site  →  equipment class  →  equipment
```

The class level earns its place: hourly operating cost, service cost and expected consumption
are naturally per *type* of machine. Without it a client with fifty machines sets fifty values
by hand. Fuel price and labour rate sit at site; a specific machine overrides at equipment.

**2. "Site" is the existing `plant`** in `src/equipment`. Do **not** create a second notion of
place. QREC0b's "site class" is about how a site's *page* is composed — a different concern
that happens to share the word.

**3. "Currency-conflict wipe" was my wording and it was wrong.** Deleting a client's cost data
automatically is not acceptable. The rule is:

> **Changing a client's currency is refused while any cost-typed parameter value exists.**
> The message names how many values and at which scopes. The client clears them deliberately,
> and that clearing is audited.

No conversion — the platform has no exchange rates, and inventing one is worse than refusing.

**4. Parameter names are a closed set**, from two sources:

- **declared by formulas** — the compiler already produces `required_parameters`
- **a platform-declared operational list**: `currency`, `fuel_price`, `labour_rate_per_hour`,
  `operating_cost_per_hour`, `stale_after_seconds`

Free-text names produce exactly the drift that silently unbound rules in the sensor catalog. A
value for an unknown parameter name is **refused**, naming it.

---

## 1. Why

`kpi-evaluator.service.ts:506` has a placeholder waiting for this. A formula that needs
`@fuel_price` cannot be evaluated, so every cost KPI in the library is unevaluatable and the
**Cost Administration** module has no backend at all.

D39 is absolute: **cost and currency are the client's alone.** Things Alive never sets them,
never reads them, and has no platform scope. A master admin seeing a customer's fuel price is
a breach, not a feature.

---

## 2. Storage

```sql
tenant_parameter (
  id, tenant_id,
  scope          text NOT NULL,   -- 'client' | 'site' | 'equipment_class' | 'equipment'
  scope_ref      text,            -- NULL for client; plant id; class slug; equipment key
  name           text NOT NULL,   -- from the closed set
  value          jsonb NOT NULL,
  unit           text,
  effective_from timestamptz NOT NULL,
  created_by, created_at
)
```

- **Append-only.** No UPDATE, no DELETE. A change is a new row with a later `effective_from`.
  The history is the audit trail and that is the point.
- **`tenant_isolation` RLS, FORCEd**, like every tenant table. A parameter leaking across
  tenants is a cost leak.
- Unique on `(tenant_id, scope, scope_ref, name, effective_from)`.

## 3. Resolution — per field, most specific wins

For a machine at time `t`, a parameter resolves by taking the **latest row with
`effective_from <= t`** at the most specific scope that has one:

```
equipment  →  equipment_class  →  site  →  client  →  not set
```

**Per field, not per profile.** A machine overriding only `operating_cost_per_hour` still
inherits `fuel_price` from its site. Resolving a whole profile at one level is the mistake to
avoid.

**Every resolved value carries its source** — scope, `scope_ref` and the row's
`effective_from`. A client asking "why is this number what it is" gets an answer without
anyone reading the database.

**Tests:** each level wins over the one above; one machine inheriting two fields from two
different levels in a single resolution; a value effective tomorrow does not apply today; the
source is reported correctly at each level.

## 4. Wire it — do not just store it

A task that stores values nothing reads is how `expected_period_seconds` sat unused for weeks.
This task connects both consumers.

**a. The evaluator's `@param` lookup.** Replace the placeholder at
`kpi-evaluator.service.ts:506`. A formula declaring `required_parameters` resolves them at
evaluation time, for that machine, at the window's end.

**A KPI whose parameter is not set is `not_configured`, `value: null`**, with a reason naming
the missing parameter. **Never 0.** A cost of zero is a number a customer will act on.

**b. `stale_after_seconds`.** Q08S s3 deferred the tenant override here. A tenant parameter
set for a machine wins over the class requirement and over the 900-second default. The order
becomes: tenant parameter → class requirement → platform default.

**Tests:** an unset parameter yields `not_configured` naming it, not 0; set, it computes; a
tenant `stale_after_seconds` overrides the class value; removing it falls back correctly.

## 5. Endpoints

```
GET    /api/v1/parameters?scope=&scopeRef=     effective values with their source
GET    /api/v1/parameters/history?name=        every row, newest first
POST   /api/v1/parameters                      set a value (appends)
GET    /api/v1/parameters/catalog              the closed set, units, which formulas need them
POST   /api/v1/parameters/currency             change the client currency
```

**All tenant-scoped. No platform route exists, and none is added.** State in the report that
you checked no platform controller can reach this table.

Guarded by a **client capability** — `parameters.write`, held by the client super admin. Not
`catalog.write`, which is a platform capability. Say which you found and which you used.

`POST /parameters/currency` implements §0.3: refused while cost-typed values exist, with the
count and scopes named.

## 6. Out of scope

- The Cost Administration UI — report the response shapes.
- Cost **calculation** — this supplies inputs to formulas; the formulas are library content.
- Any platform-level default for a cost parameter. There is none, by design.
- Anything under `frontend/`, `src/catalog-import/`, or `template-schema.ts`.

## 7. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after,
  measured on a **worktree off `origin/main`**, naming the base SHA.
- Migration timestamp assigned **at rebase**; `npm run verify:migrations` clean; full chain
  from empty; down path named with `undoMigrationNamed`.
- **Seed before you migrate.**
- Report: commit SHA, test counts with base SHA, which capability guards the endpoints, the
  confirmation that no platform route reaches the table, and anything not implemented.
