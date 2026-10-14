# QINDUSTRY — industry types, read by tool mappings

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Status: draft.** §7's questions are open. Do not start until each has a written answer
below it.

**Branch:** `feature/industry-types`, off `main`.

Drafted at the user's instruction (2026-10-12), after checking the Admin → Industry Type
sub-tab against the backend. The user chose the consumer: **tool mappings pick their
industry from this list.**

---

## 0. Why

The Industry Type sub-tab (name, code, Active/Inactive) is React state seeded from
`INITIAL_INDUSTRY_TYPES` in `mockData.ts`. Nothing reads it. The one industry field the
backend has is `tool_mapping.industry_type` — free text, typed into a text box in
`MapSensorsModal`, "not a real relation to any tenant industry list" (its entity comment).
So "Cement", "cement" and "Cemnt" are three industries today, and the list on the admin
screen describes none of them.

This task makes the list real and makes tool mappings point at it. A list with no reader
would have been a table nothing uses; this one has exactly one, chosen on purpose.

## 1. Industry types

`industry_type`, **Things Alive's reference data**, global like `tool_mapping` and
`equipment_template`: no `tenant_id`, protected by grants, not RLS (§7 Q5).

| column | rule, in the database |
|---|---|
| `name` | not blank; unique ignoring case |
| `code` | §7 Q3; unique |
| `status` | `active` \| `inactive` |
| `created_by`, `updated_by`, timestamps | |

- **Inactive** hides a type from the picker; mappings already pointing at it keep it.
- **Delete** only while nothing points at it — refused by the foreign key, not by a
  service check. A type in use is made inactive instead.

## 2. Tool mappings point at one

`tool_mapping.industry_type_id uuid NULL REFERENCES industry_type(id)` — no cascade.

The free-text `industry_type` column becomes history:

1. The migration matches each distinct existing value to a type **case-insensitively on
   name or code** and sets `industry_type_id` where exactly one matches.
2. Values that match nothing are **not** turned into types — a typo would become an
   industry. They stay in the old column, renamed `industry_type_legacy`, with
   `industry_type_id` null, and `GET /device-catalog/tool-mappings/unmatched-industries`
   lists them with counts so Master Admin can create the missing type or correct the
   mapping. §7 Q2.
3. Nothing writes the legacy column again.

**The order matters:** step 1 can only match types that exist when it runs. §7 Q1 decides
whether any do.

## 3. Endpoints

| | | capability |
|---|---|---|
| `GET /api/v1/device-catalog/industry-types` | all, `?status=active` for the picker | `device-catalog.write` (§7 Q4) |
| `POST /api/v1/device-catalog/industry-types` | create | `device-catalog.write` |
| `PATCH /api/v1/device-catalog/industry-types/:id` | rename, recode, activate / deactivate | `device-catalog.write` |
| `DELETE /api/v1/device-catalog/industry-types/:id` | refused (409, naming the count) while any mapping points at it | `device-catalog.write` |
| `GET /api/v1/device-catalog/tool-mappings/unmatched-industries` | §2 step 2 | `device-catalog.write` |

Tool mapping create/update accept `industryTypeId`, which must name an **active** type.
Responses carry `industryTypeId` and the type's `industryType` name, resolved — so the
table on the admin screen keeps rendering a name. Transitional text input: §7 Q6.

## 4. Tests

`test/industry-type.spec.ts`:

- Duplicate name (any case), duplicate code, blank name, bad code — refused by the
  database, attempted as `ta_app`.
- Deleting a type a mapping points at is refused by the foreign key; deactivating it is
  allowed and the mapping keeps it; an inactive type cannot be chosen for a new mapping.
- The migration, seeded with the state it changes (the `CLAUDE.md` rule): mappings with
  `'Cement & Building Materials'`, `'cbm'`, `'Cemnt'`, `NULL` and `''` — the first two
  matched, `'Cemnt'` left unmatched and listed, `NULL`/`''` untouched. No type created by
  the migration from a mapping's text.
- A tenant role is refused on every route (Master Admin's data, as tool mappings are).
- Down path named with `undoMigrationNamed`, and it restores the free-text values.

## 5. Out of scope

- Industry on a tenant, a site, a class or a report. Each would be a second consumer; this
  task has one.
- Changing what a tool mapping *is*, or anything about sensor mapping.
- Any change under `frontend/` — the picker in `MapSensorsModal` is the UI team's.

## 6. Done when

`npm run build` and `npm run test:db` green; `test:db` before and after on a worktree off
`origin/main`, naming the base SHA; full suite on the branch. Migration timestamp above
`main`'s newest. The report states how many Development mappings matched and how many did
not — read from the deploy's migration log, which prints both counts.

## 7. Questions — answer before starting

1. **Seed the five types in the mock** (Cement & Building Materials / CBM, Transport &
   Fleet / TRN, Automotive Manufacturing / AUT, Power & Energy / PWR, Mining & Aggregates /
   MIN)? Recommendation: **yes, if those are Things Alive's real target industries** — then
   the migration can match existing mappings against them on day one. If they are
   placeholder text, no: start empty and every existing value lands in "unmatched", which
   is honest. This is a product fact I cannot infer.
2. **Unmatched free text** — keep it as `industry_type_legacy` and list it (recommended),
   or discard it? Recommendation: keep. Throwing away what someone typed is irreversible,
   and the list is what turns it into a decision.
3. **Code format.** Recommendation: 2–10 characters, uppercase letters and digits, unique —
   the mock's codes are three uppercase letters. Stored uppercase.
4. **Who reads the list?** Recommendation: `device-catalog.write` (Master Admin), the same
   as the tool mappings that use it. No tenant reads it today; when one needs to, that is
   the second consumer §5 leaves out.
5. **Global, not per tenant?** Recommendation: global. Tool mappings are Things Alive's,
   and a per-tenant list could not be referenced from a global row.
6. **Keep accepting the free-text `industryType` on tool mapping writes for a while?** The
   current UI sends text. Recommendation: accept it **only when it matches one active type
   exactly** (name or code, ignoring case) and store the id; anything else is a 400 naming
   the active types. The UI keeps working for valid input, and nothing new lands in free
   text. Drop the text field once the UI sends `industryTypeId`.

## 7a. Answers (2026-10-14 — the user said to take the recommendation each time)

1. **Not seeded.** The recommendation was conditional on the five being real target industries,
   which nobody has confirmed, so the list starts empty: every existing value lands in
   "unmatched", kept and listed. Added so that is not a dead end:
   `POST /device-catalog/tool-mappings/unmatched-industries/rematch` applies the migration's own
   rule (exactly one active type by name or code, ignoring case) once Master Admin has created
   the real types, and never moves a mapping already set.
2. **Keep** as `industry_type_legacy`, listed with counts. A trigger refuses any write that
   changes it.
3. **2–10 uppercase letters or digits, unique, stored uppercase** (the service uppercases input).
4. **`device-catalog.write`** on every route.
5. **Global.**
6. **Text accepted only when it names exactly one active type** (name or code, ignoring case);
   otherwise a 400 naming the active types. Responses keep `industryType` as the resolved name.
