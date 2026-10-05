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
- Never `git stash drop` or `git stash clear`. A dropped stash is unrecoverable; if a
  stash must be reapplied, use `git stash apply`, never `git stash pop`, so a conflict
  mid-apply still leaves the stash intact. Measure a before/after baseline on a
  throwaway commit or a second worktree, not by stashing — stashing ties the only copy
  of in-progress work to a procedure with a lossy step.

## Railway
- Read-only by default. Querying status, logs, variables and deployments is always fine;
  changing anything is not, unless a task grants an explicit, written, narrow exception —
  and the exception is only as wide as it says, no wider.
- Creating a service that does not yet exist, and setting its own variables, is safe by
  construction: nothing that already works can break from something new appearing beside
  it (QOPS2's precedent).
- Changing a variable on an existing service is the one action that can break something
  that already works for everyone. Do it only when a task names the exact service, the
  exact variable, and a read-append-verify procedure — and run that procedure
  programmatically (read into a variable, append, set, read back and diff), never by
  hand-transcribing a value you read into a new command. A value you retype from memory
  is indistinguishable from one you got wrong.
- `railway up`, `railway redeploy`, `railway down` and `railway config migrate` are not
  part of the read path. Do not run them without being told to — including against a
  service you just created yourself, even mid-task when it would obviously help.

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
- Report: files created, files changed, test counts before and after, and every
  assumption you had to make.

## Commits, branches, merges
- Commit and push when the task is green. Branches are yours.
- Never force-push. Never push to `main`, `feature/dev`, `integration` or `production`.
- Opening the MR is fine; **merging is Deepak's**, always.
- Measure baseline test counts on a throwaway commit or a second worktree, never by stashing.
  Never `git stash drop` or `git stash clear`; `apply`, not `pop`.

## Two streams
Two builders work at once. Stream A is the machine page (QREC0a → QREC0b → QPAGE1 → QREC0c).
Stream B is independent backend work (QPARAM1, QAVAIL1, QCAT2, QCE5). Deepak is the only
architect: design questions go to him, he owns `docs/ai/task-register.md`, and he merges
every MR. Builders read the register and never edit it.

- **Start from the repo, not a chat.** A task begins from `docs/ai/prompts/<TASK>-prompt.md`
  on a freshly pulled `main`. Before building, read `docs/ai/schema-inventory.md` and check
  that nothing the prompt specifies already exists.
- **Ownership.** Only Stream A touches `src/catalog-import/**`, `template-schema.ts` and
  `CLASS_CONTENT_INVENTORY`. Only Stream B touches `src/parameters/**`, `src/utilization/**`,
  `src/shift/**` and `src/device-catalog/**`. Anything outside your stream goes back to
  Deepak — decline it and report, even when it looks small.
- **`kpi-evaluator.service.ts` is shared.** QPARAM1 merges first; Stream A rebases onto it.
  Never have both streams open in that file at once.
- **Assign the migration timestamp at rebase, never when the branch is cut.** The last step
  before opening the MR: `git fetch && git rebase origin/main`, pick a timestamp above
  everything on `main`, rename the file and its class, `npm run verify:migrations`,
  `npm run test:db`. A timestamp picked early collides with the other stream's, and the
  collision shows up as an out-of-order chain on a fresh database — in production, not in
  tests. Never reuse a timestamp that has been pushed; never renumber one that has been
  deployed. If two collide anyway, the second to merge renames and re-runs the chain from
  empty.
- **Shared files are append-only:** `package.json`'s `test:db`, `CLAUDE.md`, the operator
  registry (entries alphabetical, never renumbered). A reordered file conflicts on every
  line; an appended one on none. On a rebase conflict in one of them, keep both additions.
  If it is not a clean "both added a line", stop and report.
- **Regenerate `docs/ai/schema-inventory.md` at rebase,** after the other stream's merge.
- **A conflict in the other stream's files: stop.** Report which files, which stream owns
  them and what you were doing. Resolving someone else's file by guessing is how a
  validator ends up with two sets of rules.
- **The prompt disagrees with `main`: stop and report, do not reconcile.** A builder who
  quietly bridges the gap produces a second way of doing the same thing.
- **A passing test now fails: find out whether the test was right** — twice a test here
  passed for the wrong reason. Fixtures may change; an assertion change is a behaviour
  change and is said out loud.
- **Green locally, red in CI:** replicate `.github/workflows/ci.yml`'s jobs locally against
  a clean Postgres. Never merge past a red gate, and never force a redeploy past a deploy
  stuck WAITING — find out why the suite did not run.
- **Cadence.** Rebase daily. A branch lives 2 days at most — longer means the task should
  have been split, and it is escalated, not nursed. Deepak merges one MR at a time; the
  other stream rebases before the next.
- **Baselines** are measured on a worktree off `origin/main`
  (`git worktree add ../baseline origin/main`), reported before and after on the same base,
  naming its SHA. A count against a different base is not a count.
