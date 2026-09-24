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
