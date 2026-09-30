# Equipment library structure + Excel import — CLI task prompts

Four slices, in order. One `claude` session per slice, `/clear` between them, paste the
block verbatim. Every prompt ends with "stop, I commit" — that is deliberate.

Part 0 is not a task. It is a file you save once, and it is the single biggest thing you
can do to make every later prompt shorter, faster and less likely to wander.

---

## Part 0 — `CLAUDE.md` at the repo root (save once, commit once)

Claude Code reads this automatically at the start of every session in this repo. Putting
the standing rules here means no prompt has to repeat them, which is both cheaper and
more reliable than trusting me to remember them in each one.

Create `CLAUDE.md` in `C:\dev\things-alive-iot-platform-2.0` with exactly this:

```markdown
# Things Alive IoT Platform 2.0 — working rules

## Orientation
Read `docs/ai/START-HERE.md` and `docs/ai/REPO_MAP.md` before anything else.
`docs/ai/DECISIONS.md` records decisions already taken — read the ones a task names.
Do not re-derive a decision that is already written down there.

## Hard constraints
- 2.0 **reads** the legacy IoT backend. It never writes to it.
- Users are created in 2.0. The legacy backend holds raw data only.
- Do not create, edit or delete anything under `frontend/` or `web/`. Both stay.
  The UI is built by the UI team. Build the API that supports it, never the page.
- Do not add an npm dependency unless the task explicitly approves it by name.
- Do not edit an existing test to make new code pass. If an existing test fails,
  stop and report it.
- Do not change a migration that has already been committed. Add a new one.

## Style
- Comments explain *why*, not what. Match the voice of
  `src/database/migrations/1757960000000-SignalBindings.ts` and
  `test/signal-binding.spec.ts`.
- A rule that protects data integrity belongs in the database, not only in a service.
  A service check loses to a concurrent write.
- Tests assert a refusal by attempting the forbidden thing and expecting the database
  or the service to refuse it — not by asserting a constraint exists.

## Scope discipline
- Read only the files the task names, plus what those files import. Do not survey the
  repo. If you believe you need a file the task did not name, say which and why.
- Create only the files the task names. Changing anything else needs a sentence
  saying why, before you do it.
- When something in the task is ambiguous or turns out to be wrong, stop and say so.
  Do not choose for me and carry on.

## Finishing
- `npm run build && npm run test:db` must pass before you report done.
- Then stop. Do not commit, do not push, do not open a merge request. I commit.
- Report: files created, files changed, test counts before and after, and every
  assumption you had to make.
```

---

## Part 1 — QL1: library schema

Three tables, one migration, one spec. No services, no entities, no routes — those come
with the slices that consume them.

```
Task QL1: equipment library schema — requirements, capabilities, formulas.

Read first (and only these, plus what they import):
  src/database/migrations/1757960000000-SignalBindings.ts   (style, grants, trigger pattern)
  src/catalog/entities/equipment-class-profile.entity.ts     (expected_signals shape)
  test/signal-binding.spec.ts                                (test voice)
  src/database/migrations/1757680000000-Catalog.ts           (uq_equipment_class_profile_version)

Create exactly two files:
  src/database/migrations/1757970000000-LibraryStructure.ts
  test/library-structure.spec.ts

All three tables are PLATFORM-owned: no tenant_id, no row-level security, exactly like
equipment_class_profile. Grant SELECT, INSERT, UPDATE to ta_app on each.

TABLE equipment_class_sensor_requirement
  id uuid PK default gen_random_uuid()
  class_slug text NOT NULL
  class_version int NOT NULL
  FOREIGN KEY (class_slug, class_version)
    REFERENCES equipment_class_profile (slug, version)
    -- legal because uq_equipment_class_profile_version already exists
  measurement_role text NOT NULL       -- same vocabulary as signal_binding_version.measurement_role
  component_scope text NOT NULL DEFAULT ''   -- '' = machine level; else 'hopper', 'hydraulic-tank'
  criticality text NOT NULL DEFAULT 'required'
    CHECK (criticality IN ('required','recommended','optional'))
  min_count int NOT NULL DEFAULT 1 CHECK (min_count >= 1)
  canonical_unit text
  enables text[] NOT NULL DEFAULT '{}'
    CHECK (enables <@ ARRAY['data_quality','physics_calculation','physics_forecast',
      'approved_rule','statistical_anomaly','recommendation_ai','predictive_ml','agent_action'])
  notes text
  UNIQUE (class_slug, class_version, measurement_role, component_scope)

  Only criticality = 'required' counts toward coverage. min_count exists because a
  composite machine legitimately needs two probes for one role. enables is what lets a
  missing role say which intelligence layer it blocks, instead of a single ready/not flag.

TABLE sensor_role_capability
  id uuid PK
  sensor_id uuid NOT NULL REFERENCES sensor(id) ON DELETE CASCADE
  measurement_role text NOT NULL
  parameter_key text          -- which entry of sensor.parameter_specs supplies it
  canonical_unit text
  UNIQUE (sensor_id, measurement_role, parameter_key)

  This is what answers "which catalogued sensor could satisfy this unmet requirement".

TABLE equipment_class_formula
  id uuid PK
  class_slug text NOT NULL, class_version int NOT NULL
    FOREIGN KEY (class_slug, class_version) REFERENCES equipment_class_profile (slug, version)
  formula_key text NOT NULL
  kind text NOT NULL CHECK (kind IN ('physics','empirical','ml_feature'))
  expression text NOT NULL
  inputs text[] NOT NULL DEFAULT '{}'
  output_unit text
  basis text                  -- where the formula comes from: standard, OEM manual, paper
  references jsonb NOT NULL DEFAULT '[]'::jsonb
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','approved','retired'))
  approved_by text, approved_at timestamptz
  version int NOT NULL DEFAULT 1
  created_at timestamptz NOT NULL DEFAULT now()
  compiled_plan jsonb          -- written by the approval step, never by the importer
  compiled_at timestamptz
  compiler_version text
  UNIQUE (class_slug, class_version, formula_key, version)
  Partial unique index: one approved row per (class_slug, class_version, formula_key)
    WHERE status = 'approved'
  CHECK: status = 'approved' requires approved_by IS NOT NULL
  CHECK: kind = 'physics' requires cardinality(inputs) > 0

  The expression is STORED, NEVER EVALUATED in this slice. Formulas are written by
  domain people and loaded as data; the evaluator is a later task. An approved formula
  with no named approver is indistinguishable from nobody having reviewed it.

ONE TRIGGER, on equipment_class_sensor_requirement INSERT and UPDATE:
  refuse a measurement_role that does not appear as e->>'signal' in that class version's
  expected_signals jsonb. A required role the class never declares makes coverage
  permanently unreachable and looks forever like a data problem rather than a typo.

DO NOT add an immutability trigger for published class versions. It would break
`npm run seed:catalog` on re-run. Say so in the migration comment and leave it to the
service layer.

down(): drop the three tables and the trigger function. Leave nothing behind.

Tests — assert each refusal by attempting it:
  a requirement whose role is not in expected_signals
  enables containing a layer that is not in the enum
  a duplicate (class, role, component_scope)
  min_count = 0
  an FK to a class version that does not exist
  two approved formulas for one formula_key
  an approved formula with no approved_by
  a physics formula with empty inputs
  the down path leaves none of the three tables behind

npm run build && npm run test:db, then stop. I commit.
```

---

## Part 2 — QIMP1: workbook template and parser

The import is three slices because parse, validate and apply fail differently and want
separate tests. This one does not touch the catalog tables at all.

```
Task QIMP1: catalog import — staging tables, workbook parser, template generator.

Read first (and only these, plus what they import):
  src/database/migrations/1757970000000-LibraryStructure.ts   (the tables being loaded)
  src/catalog/entities/equipment-class-profile.entity.ts
  src/catalog/catalog.controller.ts                           (existing capability names)
  src/database/seeds/seed-catalog.ts                          (how catalog content loads today)

Approved dependency: exceljs. Add it, and nothing else.

Create:
  src/database/migrations/1757980000000-CatalogImport.ts
  src/catalog-import/ (module, entities, parser service, template service)
  scripts or npm script `catalog:template`
  test/catalog-import-parse.spec.ts

TABLE catalog_import_batch   (platform-owned, no RLS, grants to ta_app)
  id uuid PK
  filename text NOT NULL
  checksum_sha256 text NOT NULL UNIQUE      -- the same workbook cannot be staged twice
  template_version text NOT NULL
  uploaded_by text NOT NULL
  status text NOT NULL DEFAULT 'parsed'
    CHECK (status IN ('parsed','validated','rejected','applied'))
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
  error text
  created_at timestamptz NOT NULL DEFAULT now()
  applied_at timestamptz, applied_by text

TABLE catalog_import_row
  id uuid PK
  batch_id uuid NOT NULL REFERENCES catalog_import_batch(id) ON DELETE CASCADE
  sheet text NOT NULL
  row_number int NOT NULL        -- the row number as the person sees it in Excel
  entity_kind text NOT NULL
  payload jsonb NOT NULL
  status text NOT NULL DEFAULT 'parsed'
    CHECK (status IN ('parsed','valid','invalid','applied','skipped'))
  message text
  target_ref text                -- what it resolved to, once applied
  UNIQUE (batch_id, sheet, row_number)

  Every row is kept, including the rejected ones. An import that silently drops rows is
  how a class ends up half-loaded with nobody able to say which half.

PARSER (this slice's real work):
  - Sheets: _meta, equipment_class, expected_signal, failure_mode, sensor_requirement,
    sensor_capability, default_threshold, formula.
  - _meta carries template_version, generated_at, author. A workbook with no _meta sheet,
    or an unknown template_version, is REFUSED as a whole — never parsed leniently.
    A template that changed shape and was read with the old column meanings is the worst
    failure available here, because it succeeds.
  - Header row must match the template's columns by name. An unknown column refuses the
    file and names the column. This mirrors additionalProperties:false in the contracts.
  - Blank rows are skipped, not rejected. A row with a blank required cell is rejected
    with the sheet, row number and column name in the message.
  - Multi-value cells (failure_mode.signals, requirement.enables, formula.inputs) are
    comma-separated and trimmed.
  - The parser writes catalog_import_row rows and NOTHING to the catalog tables.

TEMPLATE GENERATOR: `npm run catalog:template` writes an .xlsx with every sheet, the
exact headers, one filled example row per sheet, an _enums sheet listing every allowed
enum value, and _meta pre-filled with the current template_version. This is the file
that gets handed to whoever writes the library content, so it has to be self-explaining
without a separate document.

Tests: a good workbook parses to the expected row counts per sheet; a missing _meta is
refused; an unknown template_version is refused; an unknown column is refused and names
the column; a blank required cell is rejected with sheet/row/column; the same workbook
staged twice is refused by the checksum; nothing is written to any catalog table.

Out of scope: validation beyond shape, the diff, the endpoints, applying. QIMP2 and QIMP3.

npm run build && npm run test:db, then stop. I commit.
```

---

## Part 3 — QIMP2: validation and dry-run diff

```
Task QIMP2: catalog import — semantic validation, dry-run diff, endpoints.

Read first: src/catalog-import/ (everything QIMP1 created),
  src/catalog/catalog.controller.ts (reuse its capability — do NOT invent a new one),
  src/database/migrations/1757970000000-LibraryStructure.ts

Create the validator service, the diff service, the controller, and
test/catalog-import-validate.spec.ts. Change the QIMP1 files only where the task requires.

VALIDATION, per row, recording status and message on catalog_import_row:
  - every referenced class_slug exists in this batch or is already in the catalog
  - a sensor_requirement's measurement_role appears in that class's expected_signal rows
    (the same rule the database trigger enforces — caught here so the person gets a row
    number instead of a constraint name)
  - enables, criticality, kind, status values are in their enums
  - units are non-empty where the column requires one
  - a formula's inputs all name a declared expected_signal or another formula_key
  - a sensor_capability's sensor_name resolves to exactly one row in `sensor`;
    zero or several is a rejection, not a guess
  - duplicates within the batch are rejected naming both row numbers
  - a threshold's min must be below its max; equal or inverted bounds are rejected

DRY-RUN DIFF, returned as structured JSON, writing nothing to the catalog:
  per class: would create / would create new version N+1 / unchanged, and the counts per
  sheet beneath it; then every rejected row with its sheet, row number and reason.
  A batch with any invalid row can still be applied — the invalid rows are skipped and
  recorded as skipped. Say that explicitly in the response, because a partial apply that
  looks total is worse than a refusal.

ENDPOINTS (master-admin scope, reusing the existing catalog capability):
  POST   /platform/catalog/imports          multipart upload -> parse -> validate -> batch id
  GET    /platform/catalog/imports          recent batches
  GET    /platform/catalog/imports/:id      the diff
  GET    /platform/catalog/template         downloads the generated template

Tests: each validation rule refuses its own case with a usable message; a valid workbook
produces a diff with the right create/new-version/unchanged classification; the diff
writes nothing to the catalog tables; the endpoints refuse a caller without the capability.

npm run build && npm run test:db, then stop. I commit.
```

---

## Part 4 — QIMP3: apply

```
Task QIMP3: catalog import — apply, versioned and provenanced.

Read first: src/catalog-import/ (all of it), src/catalog/services/ (how a class version is
created and published today), src/database/migrations/1757970000000-LibraryStructure.ts

Create the apply service, the endpoint, and test/catalog-import-apply.spec.ts.

POST /platform/catalog/imports/:id/apply

RULES:
  - One transaction for the whole batch. A partial write is never left behind.
  - A published class version is NEVER mutated. Content for an existing class creates
    version N+1 in status 'draft'. Publishing stays the separate action it is today.
  - Every row written carries its provenance: the batch id and 'excel-import' as source.
    A value nobody can trace back to a file and a row is a value nobody can correct.
  - Rows marked invalid are skipped and recorded as skipped, not silently dropped.
  - Applying a batch twice is refused — status must be 'validated' to apply.
  - The batch's summary jsonb records what was created, per table.

Tests: apply creates the class, its expected signals, failure modes, requirements,
capabilities, thresholds and formulas; applying to an existing published class produces
version N+1 and leaves the published version byte-identical; a second apply is refused;
a batch with invalid rows applies the valid ones and records the rest as skipped;
provenance is present on every written row; a failure mid-apply rolls back completely
(force one and assert the tables are untouched).

npm run build && npm run test:db, then stop. I commit.
```

---

## Sheet reference (for whoever writes the content)

| Sheet | Columns |
|---|---|
| `_meta` | template_version, generated_at, author |
| `equipment_class` | slug, name, description, category, service_interval_hours |
| `expected_signal` | class_slug, signal, unit, required, description |
| `failure_mode` | class_slug, code, name, symptom, signals |
| `sensor_requirement` | class_slug, measurement_role, component_scope, criticality, min_count, canonical_unit, enables, notes |
| `sensor_capability` | sensor_name, measurement_role, parameter_key, canonical_unit |
| `default_threshold` | class_slug, signal, comparator, value, unit, severity |
| `formula` | class_slug, formula_key, kind, expression, inputs, output_unit, basis, references |

`signals`, `enables` and `inputs` are comma-separated. `required` is TRUE/FALSE.
Anything generated elsewhere gets pasted into this shape — the template is the contract.

---

## Part 5 — QIMP4: unblock the import loop, and stop it damaging the library

```
QIMP4 — unblock the import loop, and stop it damaging the library

Read `CLAUDE.md` first. Append the task to `docs/ai/tasks/equipment-library-import-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b fix/import-loop`

Migration timestamp above every migration on `main`, and above whatever
`feature/telemetry-partitioning` took — check both.

---

## What happened

The library team loaded nine class versions into Development. `source` and
`import_batch_id` on `equipment_class_profile` say how each arrived:

| class | version | source | batch | state |
|---|---|---|---|---|
| 1160-mt, crawler-crane-hyd, hs-8070-hd, pg-430-100 | 1 | excel-import | `285e4f77` | correct, 25–26 signals, 6–7 failure modes |
| ex-1200v | 1 | excel-import | `285e4f77` | 25 signals, 6 failure modes |
| **ex-1200v** | **2** | excel-import | **`285e4f77`** | 25 signals, **0 failure modes** |
| diesel-generator | 1 | excel-import | `4e5f998b` | 1 signal — a separate, smaller upload |
| **crane-400-kw** | **1 and 2** | **manual** | **NULL** | 1 signal, `{"unit":null,"signal":"temp"}`, scenario with `required_signals: []` |

Three separate findings, not one:

1. **`ex-1200v` v1 and v2 came from the same batch**, and v2 dropped every failure mode.
   One apply produced two versions of one class and the second lost content. That is a
   real apply-path bug and the reason §4's `content_regression` warning exists.
2. **`crane-400-kw` is `source = 'manual'`** — written through the API, never through the
   import. The API accepted a signal with a null unit and a scenario with no required
   signals; the import validator would have refused both. **Two write paths, one
   validator** — §5.
3. The duplicate-detection bug is still real and still blocks the loop, but it did **not**
   cause the low signal counts. Four classes in the same batch loaded correctly.

Published versions are immutable, so none of this can be repaired — only superseded. And
the team could not re-upload a corrected workbook, because the checksum constraint refuses
a file it has already seen.

Four fixes, and one that stops it happening silently again.

---

## 1. Duplicate detection is scoped to the class

A signal row's identity is **`(class_slug, signal, component_scope)`** — the key template
v3 was built around. `coolant_temperature` belongs on a diesel generator, an excavator and
a compressor, and all three are correct.

Find where the validator dedupes and scope it. Report which file and what it was keyed on.

**Tests:**

1. One workbook, three classes, all declaring `coolant_temperature` with the same unit →
   **all three accepted**, each class ends with its own row.
2. One workbook, one class, the same signal twice with the same `component_scope` →
   the second is **rejected** as a duplicate. That check is still wanted.
3. Same class, same signal, **different `component_scope`** → both accepted.

## 2. The checksum constraint goes

`catalog_import_batch.checksum_sha256` is unique, so a file cannot be staged twice. But
the loop is **upload → read diff → fix → upload again**, and when the fix is outside the
workbook — creating a missing sensor capability — the file is unchanged and the checksum
is identical. Renaming does not help; the checksum is content.

It was solving a problem the apply side already solves: identical content mints no new
class version. Staging twice costs nothing and the diff is the real gate.

- **Drop the unique constraint** in a migration.
- Keep the checksum column — it is useful provenance.
- The diff may *note* "identical to batch X staged 10 minutes ago". It must never refuse.

**Test:** the same file staged twice produces two batches, both usable.

## 3. Discard a batch

```
DELETE /api/v1/platform/catalog/imports/:id
```

Allowed only when the batch has **not been applied**. Deletes its rows and itself.
Guarded by `catalog.write`.

**Tests:** an un-applied batch is deleted; an applied batch is **refused** with a reason.

## 4. The diff must report what a class is about to lose

This is the fix that matters most. The import did not fail silently — it listed the
rejects — but "some rows were rejected" and "this class is about to be published with 1 of
its 26 signals" read identically, and nobody noticed for days.

Add to the dry-run diff, **per class**:

```
{ classSlug, signalsInWorkbook, signalsToApply, rejectedRows,
  previousPublishedVersion: { version, signalCount, failureModeCount } | null }
```

And two explicit warnings:

- **`incomplete_class`** — `signalsToApply < signalsInWorkbook`. The workbook asked for
  more than will be written.
- **`content_regression`** — a previous published version of this class had more signals
  or more failure modes than this one will. That is the `ex-1200v` case: 6 failure modes
  became 0 and nothing said so.

**Apply must refuse** when either warning is present, unless the caller passes
`acknowledgeWarnings: true`. Not a UI checkbox to click past — a field the caller has to
set deliberately, which appears in the audit trail.

**Tests:**

4. A workbook where one class's signals are rejected → diff carries `incomplete_class`
   with both counts.
5. Apply without `acknowledgeWarnings` on such a batch → **refused**, message names the
   class and the counts.
6. Apply with `acknowledgeWarnings: true` → succeeds.
7. Re-uploading a class with fewer failure modes than its published version → diff carries
   `content_regression` naming the previous version.

## 5. One validator, both write paths

`crane-400-kw` v1 and v2 are `source = 'manual'`, `import_batch_id = NULL`. They hold a
signal `{"unit": null, "signal": "temp"}` and a scenario with `required_signals: []`.
Neither would survive the import validator. The API authoring path has its own, weaker
rules — so the import's rules are decoration: anything refused there can be written
through the API instead.

**Extract the content validation into one module and call it from both paths.** Report
where the two sets of rules live today and what each enforced.

Minimum the shared validator refuses, on **either** path:

- a signal with a null or empty `unit`
- a signal whose capability is not in the sensor catalog
- a scenario with `required_signals: []`
- a class published with zero signals

**Tests:** each of the four, once through the import apply path and once through the API
authoring endpoint — same refusal, same message shape. Eight tests, not four.

## 6. Why did one batch mint two versions?

Batch `285e4f77` produced `ex-1200v` v1 **and** v2. Find out how and say so in the report —
whether the workbook held the class twice, or apply ran twice against one batch, or the
version bump fires per sheet. Fix it if it is cheap and inside this task's surface;
otherwise report it and I will scope it separately. **Do not widen the branch to chase it.**

## 7. Out of scope

- The missing-capability review flow — QIMP5.
- Retire vs delete on sensor capabilities — QCAT2.
- Repairing the damaged classes. That is content work: re-upload once this ships, which
  mints new versions, then retire the broken ones. **Do not write a data migration to
  patch published rows** — immutability is the rule that makes the catalogue trustworthy,
  and a one-off exception is how it stops being one.
- Anything under `frontend/`.

## 8. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Report counts before and
  after, measured by stashing back and running.
- Full migration chain from an empty database, and the down path named explicitly with
  `undoMigrationNamed`.
- **Seed before you migrate** — the dropped constraint must be tested against a table that
  already holds batches, not an empty one.
- Report: commit SHA, test counts, the file and key the duplicate check was using before
  the fix, where the two validators lived and what each enforced, the answer to §6, and
  anything not implemented with the reason.
```

---

## Part 6 — QIMP5: the sensor catalog — propose from the workbook, create on approval

```
QIMP5 — the sensor catalog: propose from the workbook, create on approval

Read `CLAUDE.md` first. Append the task to `docs/ai/tasks/equipment-library-import-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/import-sensor-review`

Migration timestamp above every migration on `main` — `!41` and `!42` have both landed, so
check rather than assume.

---

## What the diagnostic established

- `sensor` holds **3 rows**. The workbook proposes roughly forty sensors that do not exist.
- Every reject in both batches was `count === 0` — **not found**, never ambiguous.
- `sensor_role_capability` is empty and unrelated to this check. Ignore it.
- `duplicate_in_batch` fired on byte-identical rows: the author registered one physical
  sensor's capability once per class, because `sensor_capability` is a **global** sheet and
  nothing said so.

Nothing was broken. **Nobody authored the sensor catalog**, and the import correctly refused
to invent one. This task makes the workbook propose it and a master admin approve it.

The refusal itself stays. A signal must resolve to a catalog entry or the platform has no
normalised unit for it, and rule binding is by `(signal, unit)` — a name meaning °C on one
class and °F on another silently unbinds every rule that touches it. Auto-creating from a
workbook is exactly how that happens. **Review, not auto-create.**

---

## 1. Split the reject codes

`"${name}" resolves to ${count} sensor(s)` covers not-found and ambiguous with one string.
That single message cost us four days and two wrong diagnoses.

- `sensor_not_found` — no match. Message names the sensor and says it can be proposed.
- `sensor_ambiguous` — more than one match. Message lists every candidate's slug and unit.

**Test:** each code fires on its own condition, and the ambiguous message names all
candidates.

## 2. Resolve by a stable key, not a display name

Add `slug` to `sensor`: unique, lowercase, `[a-z0-9-]`. Backfill the three existing rows by
slugifying their names — three rows, so do it in the migration and assert the count.

Resolution order in the validator:

1. `sensor_slug` if the row supplies one → exact match, no fallback.
2. otherwise `sensor_name` → case-insensitive, whitespace-trimmed match, and the diff
   carries a `name_matched` note saying which slug it resolved to.

The `sensor_capability` sheet gains an **optional** `sensor_slug` column. Optional now;
QREC0 bumps the template to v4 and makes it the primary. **Do not bump the template
version in this task** — an optional added column does not need one.

**Tests:** slug match; name match case- and whitespace-insensitively with the note; a slug
that does not exist is `sensor_not_found` even when a name in the row would have matched.

## 3. Identical global rows are a no-op

On `sensor_capability` and any other global sheet:

- **Identical** rows — same sensor, same `parameter_key`, same `canonical_unit`, same every
  other field — collapse to one. The diff carries `deduplicated_rows` with the count and
  the row numbers. **Not a rejection.**
- **Conflicting** rows — same sensor and `parameter_key`, any field differing — are a hard
  error, `conflicting_capability`, naming both rows and the fields that differ.

**Tests:** four identical rows → one capability, `deduplicated_rows: 4`, nothing rejected;
two rows differing only in `canonical_unit` → `conflicting_capability` naming both units.

## 4. The diff proposes the missing sensors

```
proposedSensors: [
  { slug, name, category, parameterKey, canonicalUnit,
    proposedByRows: [...], usedByClasses: [...] }
]
```

One entry per distinct sensor, not per row. A sensor used by six classes is one proposal
listing six `usedByClasses`. `slug` is derived from the name when the row gives none —
show the derived slug so the approver sees what will be created.

`sensor_ambiguous` never becomes a proposal — an ambiguous name is a naming problem the
author resolves, not something to create around.

**Categories are proposable too.** `sensor_category` holds **3 rows**, and forty sensors
across six equipment classes will not fit three categories. If an unlisted category were
merely refused, the re-upload would stall at the same wall one step later.

```
proposedCategories: [ { slug, name, proposedBySensors: [...] } ]
```

A sensor whose category is proposed is itself still proposable; approving the sensor
**requires** its category to be approved in the same call or to already exist, and the
endpoint refuses the pair in the wrong order rather than creating an orphan.

## 5. Create on approval

```
POST /api/v1/platform/catalog/imports/:id/sensors
{ approveCategories: [ { slug } ... ],
  approve:           [ { slug } ... ],
  dismiss:           [ { slug } ... ] }
```

Categories are created first, in the same transaction, so one call can approve a category
and the sensors that need it.

- Guarded by **`catalog.write`**. State which capability you found this maps to and why.
- Creates only slugs present in that batch's `proposedSensors`. Anything else is
  **refused**, not ignored.
- Idempotent — a sensor created between the diff and the approval is a no-op, not an error.
  Two admins approving the same batch must not collide. Take a row lock on the batch, as
  QIMP4 did on apply.
- Records who approved or dismissed what, against the batch.
- **Re-validates the batch and recomputes the diff.** The author does not re-upload. That is
  the entire point of the task.

## 6. Apply refuses while proposals are outstanding

A batch with `proposedSensors` neither approved nor dismissed → apply is **refused**,
message names the count and the classes affected.

A dismissed proposal becomes an ordinary rejected row and feeds QIMP4's `incomplete_class`
warning, which still requires `acknowledgeWarnings`. So a partial load now takes **two
deliberate acts**.

## 7. Tests

1. A workbook naming three absent sensors → three `proposedSensors`, each listing every
   class that used it.
2. One sensor used by six classes → one proposal, six `usedByClasses`.
3. Approve two of three → those two exist as `sensor` rows; the third is still outstanding.
4. Apply with an outstanding proposal → **refused**, message names the classes.
5. Dismiss the third, then apply → succeeds only with `acknowledgeWarnings`.
6. Approval is idempotent; the same approval twice leaves one row.
7. `approve` naming a slug not in this batch's proposals → **refused**.
8. After approval the recomputed diff shows those signals applicable, **with no re-upload**.
9. Two concurrent approvals of the same batch → one set of sensors, no error.
10. A row naming a category the catalog lacks → a `proposedCategories` entry listing the
    sensors that need it.
11. Approving a sensor whose category is neither existing nor in `approveCategories` →
    **refused**, no orphan created.
12. One call approving a category and three sensors in it → all four exist, one
    transaction.

## 8. Out of scope

- Retire vs delete on sensors — QCAT2.
- Template v4 — QREC0. The added column is optional and unversioned.
- Repairing the damaged classes. Re-upload mints new versions; the broken ones are retired.
  **No data migration against published rows.**
- Anything under `frontend/`. Report the endpoint and payload shapes the console needs; the
  UI team builds the screen.

## 9. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after,
  measured by stashing back and running.
- Full migration chain from empty, down path named with `undoMigrationNamed`.
- **Seed before you migrate** — the `sensor.slug` backfill must be tested against a table
  that already holds rows, including one whose name slugifies to a collision.
- Report: commit SHA, test counts, which capability the `catalog.write` question resolved
  to, and anything not implemented with the reason.
```
