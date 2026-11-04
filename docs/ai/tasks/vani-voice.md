# Vani voice integration — plan and status

Source: *Vani × Things Alive IoT Platform — Integration Guide*, 3 Nov 2026 (Vani side live).
Branch: `feature/vani-voice`, off `origin/main` @ `2360b1b`. Merging is Deepak's.
Plan page: https://claude.ai/artifact/LwrCLUXqT6vkgqgmY9whYq

Status vocabulary follows `task-register.md`: an item is **Complete** only once merged to
`main`. Until then, done-on-branch is **In progress**.

## Status — as of 2026-11-04

| # | Step | State | Evidence |
|---|---|---|---|
| 1 | Platform token from Deepak | **Waiting** — placeholder `VANI_PLATFORM_TOKEN` | — |
| 2 | Severity mapping for our `high` | **Waiting** — placeholder `VANI_HIGH_SEVERITY`, default `warning` | `src/vani/vani-severity.ts` |
| 3 | Callback URL and its secret | **Waiting** — Deepak to confirm Vani can send a secret | — |
| 4 | `vani_account_link` | In progress (on branch) | `1763600000000-VaniVoice.ts`, `test/vani-voice.spec.ts` |
| 5 | `vani_machine_link` | In progress (on branch) | same |
| 6 | `vani_call` + `vani_call_outcome` ledger | In progress (on branch) | same |
| 7 | Vani HTTP client | In progress (on branch) | `src/vani/vani-client.ts` |
| 8 | Machine packet | In progress (on branch) — title + summary only, see open item | `src/vani/vani-queue.ts` |
| 9 | Queue with the alert, send once | In progress (on branch) | `src/vani/vani-call-sender.ts`, `test/vani-calls.spec.ts` |
| 10 | Account snapshot push | Not started | — |
| 11 | Outcome callback endpoint | Not started | — |
| 12 | Call-history read API for the UI team | Not started | — |
| 13 | Seed USA test client `usa-test-01` | Not started | — |
| 14 | DG-01 from the library, linked to `dg-01` | Not started | — |
| 15 | Test telemetry for the bearing alert | Not started | — |
| 16 | Spec with Vani mocked | In progress — 39 tests so far, covers steps 4–9 | `test/vani-*.spec.ts` |
| 17 | §7 acceptance run with Deepak | Not started | — |

Commit `cb6a297` (steps 4–9, 16 partial). Full suite on the branch: 2578 passed, 1 skipped,
0 failed.

## Configuration this needs on Railway (not yet set — needs a written exception)

| Variable | Service | Purpose |
|---|---|---|
| `VANI_BASE_URL` | scheduler | `https://vani-service-production.up.railway.app` |
| `VANI_PLATFORM_TOKEN` | scheduler | From Deepak, out-of-band. Never logged. |
| `VANI_CALLS_ENABLED` | scheduler | `true` to run the sender. Off by default. |
| `VANI_HIGH_SEVERITY` | api + scheduler | `warning` (default) or `critical` |

Unset, nothing is sent and queued requests wait without spending their attempts. A request
older than 24 hours is never sent.

## Open, and blocking something

- **Token** — blocks every live call (step 17).
- **`high` → `critical` or `warning`** — placeholder default `warning`. Decide and record as
  a D-number in `DECISIONS.md`.
- **Callback authentication** — the guide gives Vani's callback no secret or signature.
  Step 11 will refuse callbacks until `VANI_CALLBACK_SECRET` is set; Vani has to send it.
- **One tenant per Vani account** — not enforced. Needs a unique index on
  `vani_account_link.vani_account_id`, which `test/rls-coverage.spec.ts` refuses until it
  is added to `GLOBAL_UNIQUE` there. That is an edit to an existing test, so it waits for
  approval. Until then, accounts are linked by platform staff only.
- **What Vani can say** — the packet carries the alert's rule name and summary only.
  Prediction window, recommended action and health score are not stored on an alert as
  speakable text, and are not invented. For the §7 call, the alert rule's summary has to
  say it.
- **Suppressed/deferred callbacks** — the guide says a callback still fires, but its
  `outcome` enum has no value for "suppressed". Ask Deepak what Vani sends.
- **Companion spec** `ThingsAlive_Vani_MachineLane_Spec_20261103.md` — not in the repo.
