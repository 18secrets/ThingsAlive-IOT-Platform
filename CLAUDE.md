# Things Alive IoT Platform 2.0 — working rules

## Orientation
Read `docs/ai/START-HERE.md` and `docs/ai/REPO_MAP.md` before anything else.
`docs/ai/DECISIONS.md` records decisions already taken — read the ones a task names.
Do not re-derive a decision that is already written down there.

## Hard constraints
- 2.0 **reads** the legacy IoT backend. It never writes to it.
- Users are created in 2.0. The legacy backend holds raw data only.
- Do not create, edit or delete anything under `frontend/`. It stays.
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
- Any endpoint that mutates an import batch takes the batch row lock
  (`.setLock('pessimistic_write')` on the `catalog_import_batch` row, inside the
  transaction that does the writing) — not just the ones that apply it. QIMP4's apply
  and QIMP5's sensor approval each raced two overlapping calls against the same batch
  before this was caught; two is a pattern, not a coincidence.
- Any endpoint documented as idempotent has a concurrent-call test — two calls fired
  together (`Promise.allSettled`), asserting both settle without error and the write
  happened once. QIMP5's approval race was found by writing that test, not by reading
  the code; reading the code had already missed it once.
- Tests assert a refusal by attempting the forbidden thing and expecting the database
  or the service to refuse it — not by asserting a constraint exists.
- A migration's down-path test names its own migration. `undoLastMigration()` means
  "whatever is newest", which stops being yours the moment somebody adds one.

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
