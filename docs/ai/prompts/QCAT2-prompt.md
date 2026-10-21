# QCAT2 — retire versus delete on sensors and categories

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.
Append the task to `docs/ai/tasks/equipment-library-import-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b feature/sensor-retire`

**Stream B.** Touches `src/device-catalog` only. **Do not touch** `src/catalog-import/`,
`template-schema.ts` or `CLASS_CONTENT_INVENTORY` — Stream A owns those. Migration timestamp
**at rebase time**.

---

## 0. Why

Reported by the library team: there is no way to remove a sensor from the list. They are
right that something is missing and wrong about what it is.

**A hard delete is not the answer.** Published class versions are immutable and they
reference sensors. Deleting a referenced sensor breaks content that cannot be repaired — only
superseded. So the control that is missing is **retire**.

QIMP5 created roughly forty sensors through workbook approval. Some of those were typos or
duplicates, and they are now in every picker with no way to get them out.

## 1. Two actions, different rules

| Action | Effect | Allowed when |
|---|---|---|
| **Retire** | no longer offered in pickers or accepted on new content; **every existing reference keeps working** | always |
| **Delete** | row removed | **only** when nothing references it — no class content at any version, no tenant copy, no binding |

A retired sensor still resolves in old class versions, still renders on a machine that uses
it, and simply stops appearing where new content is authored. That is what the team actually
needs: stop a mistake spreading without breaking what already uses it.

## 2. Schema

```sql
sensor            ADD COLUMN retired_at timestamptz NULL, retired_by text NULL
sensor_category   ADD COLUMN retired_at timestamptz NULL, retired_by text NULL
```

Nullable. **No status enum** — a timestamp answers "is it retired" and "when" in one column,
and the existing catalog tables use the same shape.

## 3. Behaviour

**Retired sensors:**

- excluded from `GET /device-catalog/sensors` by default; included with `?includeRetired=true`
- **refused** when a workbook or an API call references them on **new** content, naming the
  sensor and when it was retired
- still resolve for already-published content, every version, unchanged
- still resolve for tenant copies

**A category cannot be retired while a non-retired sensor is in it.** Refuse, naming the
sensors. Otherwise a live sensor sits in a category nobody can see.

**Un-retiring is allowed** — clear `retired_at`. Retiring is a correction, and corrections
have their own mistakes.

## 4. Delete — guarded, and the guard is the feature

```
DELETE /api/v1/device-catalog/sensors/:id
DELETE /api/v1/device-catalog/categories/:id
```

Refused unless **all** hold, and the refusal **names which check failed and how many rows**:

1. no `equipment_class_profile` at any version declares a signal resolving to it
2. no `client_equipment_class` tenant copy does
3. no `signal_binding_version` references it
4. for a category: no sensor is in it, retired or not

"Nothing references it" must be **measured**, not assumed. Report in the task which tables you
checked and how you found them — if the reference graph is wider than these four, say so
rather than shipping a delete that misses one.

Guarded by `catalog.write`. Deleting published-adjacent content is not an author-only act;
state which capability you found and used.

## 5. Tests

1. Retire a sensor → absent from the default list, present with `includeRetired=true`.
2. A published class version referencing a retired sensor still resolves it, unchanged.
3. A **new** workbook row referencing a retired sensor → refused, naming it and the date.
4. The API authoring path refuses it too — **same validator, both paths**, as QIMP4 established.
5. Un-retire → it returns to the picker.
6. Retire a category holding a live sensor → refused, naming the sensors.
7. Delete an unreferenced sensor → succeeds.
8. Delete a sensor referenced by a published class → refused, naming the check and the count.
9. Delete a sensor referenced **only by a tenant copy** → refused. This is the one that will
   be missed; write it deliberately.
10. Delete a category holding a retired sensor → refused.

## 6. Out of scope

- Merging two duplicate sensors into one. That is content surgery over published versions and
  needs its own decision — report how many obvious duplicates exist in Development, do not fix
  them.
- Retiring an equipment class — that already exists.
- Anything under `frontend/`. Report the response shapes and the `includeRetired` flag.

## 7. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after on a
  **worktree off `origin/main`**, naming the base SHA.
- Migration timestamp assigned **at rebase**; chain clean from empty; down path named.
- **Seed before you migrate** — the retire tests need sensors that existed beforehand.
- Report: commit SHA, test counts with base SHA, which tables you checked for references and
  how you enumerated them, how many duplicate-looking sensors exist in Development, and
  anything not implemented.
