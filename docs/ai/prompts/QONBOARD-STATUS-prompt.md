# QONBOARD-STATUS — onboarding progress, derived

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Status: ready.** §7's questions were answered on 2026-10-12: the user accepted the
recommendation on all five.

**Branch:** `feature/onboarding-status`, off `main`.

Drafted at the user's instruction (2026-10-12) after checking the AI Onboarding page
against the backend. Not QONBOARD1, which is bulk-registering a 1.0 fleet (phase 2).

---

## 0. Why

The AI Onboarding page (`AiOnboardingPage`, `AIOnboarding`, `OnboardingList`) is two
mocks: a list of "onboarding sessions" and a chat whose eight-step checklist is a constant
in the component. Every step on that checklist already has a real backend behind it. What
does not exist is one answer to "how far along is this machine, and what is stopping it".

This task builds that answer, deterministically, from state the platform already holds.
**No language model, no new table for progress, no chat.** A progress row stored beside
the data would drift from it the first time somebody claims a device through the
inventory page instead of the wizard; derived, it cannot. A chat assistant, if one is
built later, reads this endpoint — it does not replace it (G09).

## 1. The steps

Per machine, in order. Each step is `done`, `pending` or `blocked`, and every state other
than `done` carries a `reason` — a code, never prose alone.

| step | `done` when | read from |
|---|---|---|
| `equipment` | the machine has an `equipment_profile` with a class | `equipment_profile.equipment_class_slug` |
| `device` | at least one device is claimed onto it | `device_inventory` (`tenant_id`, `equipment_external_id`, `claimed_at`) |
| `mapping` | every signal the class requires has an active binding | `SignalBindingService.coverage` — `missing` empty |
| `validation` | every required signal is reporting and fresh | the readiness the machine page already computes (`readiness_list`) — all `ready` |
| `activation` | at least one scenario is `active` | `equipment_scenario.state` |
| `alerts` | at least one enabled alert rule applies to it | `alert_rule` — `applies_to` `account`, its `plant`, its `equipment-class`, or the machine itself (`equipment`) |
| `access` | at least one user other than the account's super admins can see it | `user_equipment_access`, `user_plant_access` via its plant |

`done` overall is every step `done`. There is no "Done" step of its own — the mock's eighth
row is a summary, and a summary stored as a step is one more thing that can disagree.

**Reasons** reuse the codes that already exist wherever there is one — `unclassified`,
`unbound`, `mapping_required`, `stale`, `no_readings` — so the UI maps one vocabulary, not
two. New codes only where nothing exists: `no_device_claimed`, `no_active_scenario`,
`no_alert_rule`, `no_user_access`.

**Blocked vs pending** (§7 Q2): a step is `blocked` when an earlier step it depends on is
not `done` — mapping cannot be done with no device — and its reason names that step
(`blocked_by: "device"`). `pending` means the step itself is next.

## 2. The "session" the list shows

§7 Q1. Recommendation: a **site** is the session. The mock's row carries a name, a sites
count and an equipment count, which is a plant and its machines; "In Progress" is any
machine on it not `done`. No new object — the alternative, a stored onboarding batch, is
designing a workflow nobody has used yet.

## 3. Endpoints

| | | capability |
|---|---|---|
| `GET /api/v1/onboarding/status` | per site in scope: machine counts by overall state, and per step how many machines are done / pending / blocked | `equipment.write` |
| `GET /api/v1/onboarding/status/equipment/:system/:id` | the seven steps for one machine, each with state, reason, and the evidence it was read from (counts, ids — enough to link to the right page) | §7 Q4 |

Machines with no site are reported under a `site: null` group, not dropped.

Scope narrowing is the caller's existing scope; a machine outside it is a 404. The
`access` step needs to read user grants — for a caller without `user.manage`, it reports
`done` / not `done` only, never who (§7 Q5).

One call per page. The site summary must not issue a coverage query per machine per step;
batch them, and state the query count in the report. Machine page latency (T4, ~500 ms) is
the bar.

## 4. Tests

`test/onboarding-status.spec.ts`:

- A machine walked step by step — each write made through the existing service, not by
  inserting rows — moves exactly the step it should, and nothing else.
- Each `blocked` names the step blocking it; fixing that step turns it `pending`, not `done`.
- Releasing the device turns `device` back to `pending` and `mapping` to `blocked`: progress
  is derived, so it goes backwards when the facts do.
- A stale signal keeps `validation` from `done` with reason `stale`, not `no_readings`.
- Another tenant's machines, devices, rules and users never count — through the service and
  with RLS as the backstop.
- A machine with no site appears under `site: null`.
- The site summary on a fleet of ~50 machines runs in a fixed number of queries (assert the
  count, not the time).

## 5. Out of scope

- The chat assistant and anything that calls a model. No npm dependency.
- A stored onboarding session, wizard state, or "resume where you left off".
- Writing anything. Every step is completed through the page that already owns it.
- Bulk onboarding of a 1.0 fleet (QONBOARD1).
- Any change under `frontend/`.

## 6. Done when

`npm run build` and `npm run test:db` green; `test:db` counts before and after on a worktree
off `origin/main`, naming the base SHA. Full suite run on the branch, including
`rls-coverage.spec.ts`. OpenAPI tags and an example payload per endpoint for the UI team.
No migration expected; if one turns out to be needed, say why before writing it.

## 7. Decisions (answered 2026-10-12 — the recommendation, each time)

1. **What is a session?** Recommendation: a site (§2). The alternative is a stored batch,
   which is a new object and a workflow nobody has asked for yet.
2. **Do steps block each other?** Recommendation: yes, as in §1: `mapping` and
   `validation` need `device`; `validation` needs `mapping`; `activation` needs `mapping`.
   `alerts` and `access` depend on nothing — they can be set up first.
3. **Is `activation` an onboarding step at all?** The mock has no such row; its steps are
   device, equipment, mapping, onboarding, validation, alerts, access. Recommendation: the
   mock's "Onboarding" row *is* activation — a machine with nothing running is registered,
   not onboarded.
4. **Capability.** Recommendation: reuse `equipment.write` for both routes — onboarding is
   what the people who register equipment do, and a separate capability would gate nothing
   `equipment.write` does not already. The alternative is a read capability every role
   holds, which would show operators a setup checklist they cannot act on.
5. **`access` done means what?** Recommendation: at least one user other than super admins
   can see the machine. A super admin sees everything, so counting them would make the step
   done for every machine from day one and tell nobody anything.
