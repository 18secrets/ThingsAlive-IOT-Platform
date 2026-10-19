**Status: draft for Deepak's review** — drafted 2026-10-19 from the recorded decisions and the code on `main`; nothing here is decided that a decision file does not already decide.

# QNOTIFY1 — tell someone when an incident escalates

Read `CLAUDE.md` first. Commit this prompt to `docs/ai/prompts/` before writing code.

**Branch:** `git checkout main && git pull && git checkout -b feature/incident-notifier`

**Depends on:** the incident entity (!112, shipped), the mail module (shipped:
`src/mail/mail.service.ts`). **Answer §8 first.** Questions 1 and 2 decide who receives
what; if they are unanswered, stop and report rather than picking.

Read, in addition to what `CLAUDE.md` names: `src/incident/incident-record.service.ts`
(`escalateOverdue` and its outbox insert), `src/incident/incident-escalation.scheduler.ts`,
`src/events/domain-event.entity.ts`, `src/mail/mail.service.ts`, `docs/ai/DECISIONS.md` D11.

---

## 0. Why

Since !112 an overdue incident escalates: level 1 when acknowledgement is overdue, level 2
when resolution is. Each escalation is stored once, written to the incident's timeline, and
put in the outbox as `incident.escalated.v1`. Then nothing happens. **Nothing reads the
outbox at all** — every `domain_event` row on `main`, of every type, stays `pending`
forever. An escalation nobody hears about is the same as no escalation, only with a record
that says it happened.

So this task is two things, and the second is the one that outlives it:

1. A notifier for `incident.escalated.v1`: decide who, send it, record that it was sent.
2. **The first outbox consumer.** D11 made the PostgreSQL outbox the queue and said "the
   publisher is a loop that reads `pending` rows and marks them `delivered`". This is that
   loop, for one event type, built so the next type is a handler, not a second loop.

## 1. The event, as it is written today

```json
{ "event_type": "incident.escalated.v1", "tenant_id": "...", "subject": "<incident id>",
  "payload": { "incidentId": "...", "level": 1, "reason": "acknowledgement_overdue",
               "severity": "high", "machine": { "sourceSystem": "...", "externalId": "..." },
               "ownerUserId": "... or null" },
  "occurred_at": "..." }
```

`reason` is `acknowledgement_overdue` (level 1) or `resolution_overdue` (level 2). The
incident may have been acknowledged or resolved between the escalation and the send — read
it again at send time (§3.3).

## 2. The outbox consumer

`domain_event` already carries `delivery_state` (`pending | delivered | failed`),
`delivered_at`, `attempts`, `last_error`. Use them; do not add a second queue table.

- **Claim with `FOR UPDATE SKIP LOCKED`**, a bounded batch, oldest `occurred_at` first,
  **only event types that have a registered handler**. A `scenario.activated` row is not
  this consumer's and must stay `pending`, untouched — the broker slice (P0-16) or a later
  handler owns it.
- **Handlers are a closed registry**, keyed by `event_type`, like the executor registry: a
  type with no handler is never claimed. A test asserts every handled type is a known type.
- **At-least-once, deduplicated where it matters.** A crash between sending and marking
  `delivered` will resend on the next pass. The dedupe is a new tenant-owned table,
  `notification_delivery (event_id, recipient_user_id, channel)` with a **unique
  constraint** on that triple: the handler inserts the row before sending and skips a
  recipient whose row exists. The database, not a service check, is what stops a second
  email (CLAUDE.md: a service check loses to a concurrent write).
- **Retries are bounded.** Increment `attempts`, store `last_error`, back off; after the
  limit (§8 Q5) mark `failed`. A `failed` row is visible, never silently retried for ever.
- **Runs on the scheduler service only**, off unless `INCIDENT_NOTIFY_ENABLED=true`, on the
  pattern of `IncidentEscalationScheduler`. Name it in `.env.example`.

## 3. The notification

1. **Who** — §8 Q1. Recipients resolve to 2.0 users of *that* account, through the same
   user records and role resolution the API uses. A recipient is never derived from free
   text in an alert or a note.
2. **What** — one email per recipient: machine name and site, severity, which clock ran
   out (acknowledge or resolve) and by how long, and one link to the incident view built
   from `APP_PUBLIC_URL`. No telemetry values, no other account's data, nothing a
   recipient's role would not show them on the incident screen.
3. **Still true?** Re-read the incident at send time. Resolved → send nothing and mark the
   event `delivered` with a timeline entry saying why. Acknowledged after a level-1
   escalation → the same.
4. **Recorded** — each send is an `incident_event` on the timeline (`notified`, actor
   `system`, recipients by user id, channel), so the incident view can show who was told.

`MailService.send` returns `false` rather than throwing when mail is not configured. Treat
that as a failure to deliver (retry, then `failed`), not as success.

## 4. What the database enforces

1. `notification_delivery` unique on `(event_id, recipient_user_id, channel)`.
2. `notification_delivery` is tenant-owned: `tenant_id`, `tenant_isolation` policy,
   `FORCE`d, granted to `ta_app`. `rls-coverage.spec.ts` fails the suite otherwise.
3. `domain_event.delivery_state` may only move `pending → delivered | failed`, never back:
   a trigger, so a bug cannot re-deliver a whole backlog.

## 5. Out of scope

- Any channel but email (§8 Q2): no SMS, WhatsApp or push in this task.
- A user preference screen, quiet hours, digests (§8 Q4).
- Consumers for other event types. The registry makes them possible; adding them is theirs.
- Anything under `frontend/`. Report the incident-view field that lists who was notified.
- New npm dependencies — none are approved.

## 6. Tests

Refusals are attempted, not asserted to exist.

1. An escalation with an owner → one email to the owner (fake transport), one
   `notification_delivery` row, the event `delivered`, a `notified` timeline entry.
2. **Two consumer passes at once** (`Promise.allSettled`) over the same pending event →
   both settle, one email, one delivery row.
3. A direct second `INSERT` into `notification_delivery` for the same triple → the
   database refuses.
4. An event of a type with no handler stays `pending` with `attempts = 0` after a pass.
5. Incident resolved between escalation and send → no email, event `delivered`, timeline
   says why.
6. Mail not configured (`send` returns `false`) → `attempts` goes up, `last_error` set;
   after the limit, `failed`, and no further attempt.
7. Moving a `delivered` event back to `pending` directly → the database refuses.
8. RLS: account B's user is never a recipient of account A's incident, and cannot read
   A's delivery rows.
9. Down path: the migration's own name via `undoMigrationNamed`.

## 7. Done when

- `npm run build && npm run test:db` green, `npm run lint` clean; counts before and after
  on a worktree off `origin/main`, naming the base SHA.
- Report: files created and changed, test counts, how §8 was answered and where each
  answer lives, every assumption.

**One line for the task doc:** an escalation is only worth something if a person hears
about it, and this is the first piece of code that reads the outbox at all.

---

## 8. Questions — answer before starting

1. **Who is told, at each level?** The SLA policy holds only times; nothing names an
   escalation contact. *Recommendation:* level 1 → the incident's owner, or, with no owner,
   every user in the account with `action.assign`; level 2 → the owner plus every user with
   `action.assign` (the people who can reassign the work). Site-scoped users only for
   machines in their sites.
2. **Which channel?** Email is the only sender that exists. *Recommendation:* email only
   in this task; SMS or WhatsApp is a separate task with its own provider decision.
3. **What about escalations already in the outbox when this ships?** Escalation is off on
   Development today (`INCIDENT_ESCALATION_ENABLED` unset), so the backlog should be
   empty. *Recommendation:* deliver nothing older than 24 hours; mark those `failed` with
   `last_error = 'expired before a notifier existed'`, so nobody gets a day-old page.
4. **Opt-outs and quiet hours?** *Recommendation:* none in v1 — an escalation is by
   definition something that was already ignored once.
5. **Retry limit and backoff?** *Recommendation:* 5 attempts, backoff 1, 2, 4, 8 minutes,
   then `failed`. One named constant each.
6. **Does a level-2 escalation of an incident whose level-1 email failed send both?**
   *Recommendation:* each event is delivered on its own merits; a level 2 does not resend
   level 1.
