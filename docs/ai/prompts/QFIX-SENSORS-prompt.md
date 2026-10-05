# QFIX-SENSORS — the sensor approval endpoint 500s instead of answering

**Urgent. The library team is blocked right now.** Do this before anything else in Stream B.

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/`.
Append the task to `docs/ai/tasks/equipment-library-import-prompts.md`.

**Branch:** `git checkout main && git pull && git checkout -b fix/sensor-review-body`

No migration. Timestamp rules do not apply.

---

## 0. What is happening

Four requests to `POST /api/v1/platform/catalog/imports/:id/sensors`, 09:36–09:45 UTC
2026-10-05, all failed with:

```
TypeError: Cannot read properties of undefined (reading 'approveCategories')
```

`catalog-import-sensor-review.service.ts:61` reads `request.approveCategories ?? []`. That is
safe when `request` exists. **It does not** — the controller is handing the service
`undefined`.

**And here is why nobody caught it:** all twelve tests in
`test/catalog-import-sensor-review.spec.ts` call `review.review(id, {...}, 'deepak')` —
the service, directly. **Not one goes through HTTP.** The service is thoroughly tested and
its controller binding has never been exercised.

The team's request may well have been malformed. That is not the defect. **A malformed
request must produce a 400 that names what is wrong, never a 500 from a dereference.**

## 1. Find the actual break, and say what it was

Read the controller. Report which of these it is, with the line:

- `@Body()` missing or misspelled on the parameter
- arguments passed to the service in the wrong order
- the body genuinely arriving undefined — an empty POST, or no
  `Content-Type: application/json` — and nothing guarding it

**Do not fix it before saying which.** If it is the third, the client was wrong *and* so were
we; both halves get fixed.

## 2. A DTO, validated at the boundary

```ts
class SensorReviewDto {
  approveCategories?: { slug: string }[];
  approve?: { slug: string }[];
  dismiss?: { slug: string }[];
}
```

- A missing or empty body → **400**, saying the call must name at least one of
  `approveCategories`, `approve` or `dismiss`.
- A body with none of the three populated → **400**, same message. An approval call that
  approves nothing is a mistake, not a no-op.
- An unknown top-level field → **400** naming it. A typo'd `approveCategory` silently doing
  nothing is how someone concludes the endpoint is broken.
- An entry missing `slug` → **400** naming the array and the index.

Use whatever validation the project already uses. **Do not add a dependency** — if
`class-validator` is not already in `package.json`, hand-validate in the controller and say
so.

## 3. Close the real gap — test the HTTP path

This is the part that matters more than the fix.

Add `test/catalog-import-sensor-review-http.spec.ts`, driving the **endpoint**, not the
service:

1. No body → 400, message names the three fields.
2. `{}` → 400.
3. `{ "approveCategory": [...] }` (typo) → 400 naming the unknown field.
4. `{ "approve": [{}] }` → 400 naming the array and index.
5. A valid approval → 200, and the sensor exists afterwards.
6. Wrong capability → 403, not 500.

**Then check the other endpoints added since QIMP4 the same way** — apply, discard,
named-formula create and publish. Report which of them have **no** HTTP-level test. Do not
fix those here; I will scope them. I want to know how wide this is.

## 4. Verify against Development, read-only

After the fix is merged and deployed, confirm with the library team's actual batch
`0159a8ad…` that the diff still lists its `proposedSensors` and `proposedCategories`, and
that a well-formed approval succeeds.

**Do not approve anything on their behalf.** Read the diff, report it, and tell them the
exact body to send.

## 5. Done when

- `npm run build` clean, `npm test` and `npm run test:db` green. Counts before and after on a
  worktree off `origin/main`, naming the base SHA.
- Report: commit SHA, **which of §1's three causes it was**, test counts, and **the list of
  endpoints with no HTTP-level test**.

This is a small fix with an important finding attached. The finding is the deliverable.
