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
| 3 | Callback URL and its secret | **Waiting** — placeholder `VANI_CALLBACK_SECRET`; Deepak to confirm Vani can send it as `X-Vani-Secret` | `src/vani/vani-outcome.service.ts` |
| 4 | `vani_account_link` | In progress (on branch) | `1763600000000-VaniVoice.ts`, `test/vani-voice.spec.ts` |
| 5 | `vani_machine_link` | In progress (on branch) | same |
| 6 | `vani_call` + `vani_call_outcome` ledger | In progress (on branch) | same |
| 7 | Vani HTTP client | In progress (on branch) | `src/vani/vani-client.ts` |
| 8 | Machine packet | In progress (on branch) — title + summary only, see open item | `src/vani/vani-queue.ts` |
| 9 | Queue with the alert, send once | In progress (on branch) | `src/vani/vani-call-sender.ts`, `test/vani-calls.spec.ts` |
| 10 | Account snapshot push | In progress (on branch) — pushed when the picture changes; status = open alerts; no `health_score` | `src/vani/vani-snapshot.ts`, `1763700000000-VaniSnapshot.ts` |
| 11 | Outcome callback endpoint | In progress (on branch) — `POST /api/v1/vani/outcome-callback` | `src/vani/vani.controller.ts`, `test/vani-outcomes.spec.ts` |
| 12 | Call-history read API for the UI team | In progress (on branch) — `GET /api/v1/vani/calls?alert=&equipment=` (`prediction.read`) | same |
| 13 | Seed USA test client `usa-test-01` | In progress (on branch) — `npm run seed:vani-test`, local databases only | `src/database/seeds/seed-vani-test.ts`, `test/seed-vani-test.spec.ts` |
| 14 | DG-01 from the library, linked to `dg-01` | In progress (on branch) — library `diesel-generator` granted; site Grapevine, TX | same |
| 15 | Test telemetry for the bearing alert | In progress (on branch) — 72 h of `vibration_velocity` 2.4 → 5.2 mm/s, load ~62%, 1500 rpm; critical rule at 4.5 mm/s (decision 1a) | same |
| 16 | Spec with Vani mocked | In progress — 63 tests, covers steps 4–15 | `test/vani-*.spec.ts`, `test/seed-vani-test.spec.ts` |
| 17 | §7 acceptance run with Deepak | Not started | — |

Commits `cb6a297` (steps 4–9) and the steps 10–12 commit after it. Full suite on the branch
after steps 10–12: 2597 passed, 1 skipped, 0 failed.

## Running the test client locally

```bash
createdb ta2_vani
# migrate, then publish the library on this throwaway database only:
#   seed-catalog.ts --publish   (test databases only — it publishes every draft class)
SEED_VANI_TEST_ENABLED=true DB_DATABASE=ta2_vani npm run seed:vani-test
```

Done on 2026-11-04 against a fresh local `ta2_vani`: tenant `usa-test-client`, one
critical alert raised by the engine, one `vani_call` queued and left `pending` (no Vani
token set, so nothing rang). A second run reports "already present" and changes nothing.
The seed refuses any database host but localhost. There is no reset: start from a fresh
database instead.

Decisions taken for this phase (2026-11-04):
- **1a** — the library `diesel-generator` class has no bearing-temperature signal, so the
  test alert is a critical threshold rule on `vibration_velocity` (ISO 10816-3 zone C/D,
  4.5 mm/s), named in plain words.
- **Local only for now** — not seeded on Railway Development.

## Configuration this needs on Railway (not yet set — needs a written exception)

| Variable | Service | Purpose |
|---|---|---|
| `VANI_BASE_URL` | scheduler | `https://vani-service-production.up.railway.app` |
| `VANI_PLATFORM_TOKEN` | scheduler | From Deepak, out-of-band. Never logged. |
| `VANI_CALLS_ENABLED` | scheduler | `true` to run the sender. Off by default. |
| `VANI_HIGH_SEVERITY` | api + scheduler | `warning` (default) or `critical` |
| `VANI_CALLBACK_SECRET` | api | Shared with Vani; sent as `X-Vani-Secret`. Unset, every callback gets 503. |

Unset, nothing is sent and queued requests wait without spending their attempts. A request
older than 24 hours is never sent.

## Open, and blocking something

- **Token** — blocks every live call (step 17).
- **`high` → `critical` or `warning`** — placeholder default `warning`. Decide and record as
  a D-number in `DECISIONS.md`.
- **Callback authentication** — the guide gives Vani's callback no secret or signature.
  The endpoint refuses callbacks (503) until `VANI_CALLBACK_SECRET` is set, and then
  requires it in `X-Vani-Secret`. Vani has to be changed to send it — ask Deepak.
- **Snapshot `health_score`** — 2.0 keeps no health score, so the snapshot sends none.
  The status line is the open alerts on the machine. Confirm Vani accepts a snapshot
  without `health_score`.
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
- ~~The alert summary Vani reads is machine-written~~ — done 2026-11-04 in
  `src/vani/vani-speech.ts`, without touching the engine's own summary: a threshold alert
  is said from its evidence ("Bearing vibration on Diesel Generator DG-01 has been above
  4.5 millimeters per second on all of the last 10 readings, reaching 5.25 millimeters per
  second."). Other alert kinds keep the engine's wording with snake_case keys made into
  words; a prediction-severity summary still names its scenario slug.
- **Companion spec** `ThingsAlive_Vani_MachineLane_Spec_20261103.md` — not in the repo.

## Phase 6 — proposal for Deepak, not started

Answering a customer's questions on an inbound call from live data, rather than the
snapshot alone. Both agents already exist: Vani runs the call, and 2.0's assistant
(`src/assistant/`) runs a Gemini tool loop, up to `MAX_ROUNDS = 5`, over 14 read-only
tools limited to the caller's tenant. No new agent framework.

- **A — Vani calls our tools.** Serve the assistant's read tools over MCP, limited to one
  account. Vani's model chooses. One agent in the path; needs tool-calling on Vani's side.
- **B — Vani asks our assistant.** One endpoint: question in, short speakable answer out.
  One HTTP call for Deepak; two models in the path, roughly 3–8 s per answer on a call.

**Scoping a conversation** (raised 2026-11-04) — every answer filtered as the app filters a
signed-in person:

| Filter | Resolved by | In 2.0 today |
|---|---|---|
| Account | Vani `account_id` → `vani_account_link` → tenant | yes |
| Person | caller's E.164 number → `app_user.phone` in that tenant; unknown, suspended or shared number → snapshot only | phone yes; lookup new |
| Their machines | `ScopeResolverService` → `user_plant_access`, `user_equipment_access` | yes; assistant tools obey it |
| Machine discussed | outbound: `event_id` → `vani_call`; inbound: spoken name against `vani_machine_link`, inside scope | links yes; name matching new |
| Conversation | `conversation_id` from Vani; each turn recorded (question, tools, scope, answer) | new |

To confirm with Deepak: does Vani pass the caller's number and a conversation id, and are
Vani's registered numbers the same people as 2.0 users?

**Decision, 2026-11-04 — Option B, pending Deepak.** Vani does not access platform data or
tools. It gets one analysis tool ("ask the platform"): it sends the question, caller number,
account, machine in focus and conversation id; 2.0 runs the analysis with the assistant's
tools under that caller's scope (figures from the platform's own rules and calculations,
the model only words them); only a short speakable answer goes back, with the facts it
rests on kept in the conversation log. An unknown caller, an out-of-scope machine or data
2.0 does not have gets a plain refusal with the reason, never a guess. Option A is set aside.

Both end the guide's "Vani speaks only from the packet" rule, so Deepak agrees first.
LangGraph was considered and not proposed: the loop it provides exists here already,
and it would be a new dependency needing approval by name.
