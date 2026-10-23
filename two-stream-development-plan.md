# Running two developers in parallel

2026-10-05. For two engineers, each driving a Claude session, against one repository.

---

## 1. Roles — one architect, two builders

| Role | Who | Does |
|---|---|---|
| **Architect / product owner** | Deepak, with Claude Desktop | writes prompts, answers design questions, **owns the register**, merges every MR |
| **Builder A** | developer 1 + Claude CLI | executes prompts on branches, opens MRs, never merges |
| **Builder B** | developer 2 + Claude CLI | the same |

**Do not split the architect role.** Two people answering design questions is how the
`stale` versus `no_readings` conflation gets decided twice, differently. Every design
question goes to one place.

**Builders never edit `docs/ai/task-register.md`.** They read it. One writer.

---

## 2. The split — who builds what, and from which prompt

`QREC0a → QREC0b → QPAGE1` is strictly serial. Handing QREC0b to a second person does not
make it start sooner; it makes it start wrong. So the split is by **independent stream**.

Every prompt below lives at `docs/ai/prompts/<file>` once the pre-start checklist (§10) is
done. **A builder never starts from a prompt pasted into a chat** — only from the repo.

---

### Stream A — Builder A — the machine page (critical path)

This is the path to the client's main screen. It must not stall.

| Order | Task | **Prompt file** | Status | Touches |
|---|---|---|---|---|
| **1** | **QREC0a** — content structure, template v4 | **`QREC0a-prompt.md`** | **ready, all 7 conflicts answered** | catalog content, template, import validator |
| 2 | **QREC0b** — page layout, site class | *not written* | after QREC0a | layout tables, site class |
| 3 | **QPAGE1** — composed page endpoint | *not written* | after QREC0b | page endpoint, widget vocabulary |
| 4 | **QREC0c** — visuals, anchors, object storage | *not written* | last, by design | `equipment_class_visual`, storage |

**Builder A owns, and only Builder A touches:**

```
src/catalog-import/**        template-schema.ts
CLASS_CONTENT_INVENTORY      the class-content tables
```

---

### Stream B — Builder B — independent backend

Different modules, different tables, different tests. Nothing here blocks Stream A and
nothing in Stream A blocks it.

| Order | Task | **Prompt file** | Status | Touches |
|---|---|---|---|---|
| **1** | **QPARAM1** — tenant parameters, cost profiles | **`QPARAM1-prompt.md`** | **ready — the four open questions answered in its §0** | new parameter tables, the evaluator's `@param` lookup |
| **2** | **QAVAIL1** — availability, uptime, downtime | **`QAVAIL1-prompt.md`** | **ready** | `src/utilization`, `src/shift` |
| **3** | **QCAT2** — retire vs delete on sensors | **`QCAT2-prompt.md`** | **ready** | `src/device-catalog` |
| 4 | **QCE5** — comparison operators, `count_exceeding` | *not written* | **waits until the library is loaded** | operator registry, compiler |
| 5 | QCAT1 / QGEO1 | *not written* | later | categorical signals / geospatial |

**Builder B owns, and only Builder B touches:**

```
src/parameters/**     src/utilization/**     src/shift/**     src/device-catalog/**
```

---

### Not in either stream yet

| Task | Why it waits |
|---|---|
| **QGRANT1** | edits `CLASS_CONTENT_INVENTORY`, and so does QREC0a — a guaranteed conflict in the one file whose purpose is to be complete. **Queue it after QREC0a merges**, then it is Stream B's |
| **QML1, QARCH1, QUPGRADE1, QTWIN1** | phase 2 |
| **QGEN1–3, QWF1, QREC1–2, QEMB1, QEVAL1** | the AI layer, behind QPAGE1 and real library content |

---

### Shared surface — neither builder changes it alone

`kpi-evaluator.service.ts` is touched by **both** — Stream B wires `@param` at line 506,
Stream A will read layout from it later. **QPARAM1 goes first**, merges, and Stream A rebases
onto it. Do not have both open in that file at once.

## 3. Migration timestamps — the rule that prevents the worst collision

Two branches that each pick "a timestamp above `main`" collide, and the second one to merge
produces a chain that runs out of order on a fresh database. That failure appears in
production, not in tests.

**The migration timestamp is assigned at rebase time, immediately before the MR is opened —
never when the branch is cut.**

```
# last step before opening the MR, not the first step of the task
git fetch && git rebase origin/main
# now pick the timestamp, above everything on main
# rename the migration file and its class
npm run verify:migrations
npm run test:db
```

The timestamp is the last decision, so it is made against a `main` that already contains
whatever the other stream merged. No reservation file, no coordination, no race.

**Corollary: never share a migration timestamp between branches, and never reuse one that has
been pushed.**

---

## 4. Files that will conflict, and the protocol for each

| File | Why both streams touch it | Rule |
|---|---|---|
| `package.json` → `test:db` | every task adds a spec | **append only**, never reorder. Trivial merge |
| `CLAUDE.md` | standing rules | append a section; never edit someone else's |
| `CLASS_CONTENT_INVENTORY` | any new class-owned table | **Builder A only.** QGRANT1 waits for QREC0a |
| `operator-registry.ts` | QCE5, QREC0a | append entries alphabetically; never renumber |
| `docs/ai/task-register.md` | — | **neither builder touches it** |
| `docs/ai/schema-inventory.md` | regenerated per task | regenerate at rebase, after the other stream's merge |
| `template-schema.ts` | v4 is QREC0a's alone | **Builder A only** |
| `kpi-evaluator.service.ts` | B wires `@param`; A reads layout later | **QPARAM1 merges first**, then A rebases onto it |

The pattern is the same everywhere: **append, do not reorder**. A reordered file conflicts on
every line; an appended one conflicts on none.

---

## 5. Cadence — the thing that actually goes wrong

Four MRs sat unmerged for three days this week, and `feature/bulk-classes` is now 45 commits
behind. Neither is a technical problem.

| | Rule |
|---|---|
| **Rebase daily** | every builder, every morning, whether or not they are ready to merge |
| **Branch lifetime** | 2 days maximum. A task that cannot be green in 2 days is too big and should be split |
| **Merge serially** | Deepak merges one MR, the other stream rebases, then the next merges. Never two at once |
| **Merge same day** | an MR that is green and reviewed merges that day. The queue is the bottleneck, not the work |
| **Deploy after each merge** | confirm with `railway logs --build --lines 50` then `--lines 100`. Two merges before a deploy means two suspects when it breaks |

**A branch more than 2 days old is escalated, not nursed.** The import screen on
`feature/bulk-classes` is the example: written before QIMP4 and QIMP5, it now cannot complete
the flow it was built for.

---

## 6. Test counts with two streams

Measuring a baseline by stashing or by checking out `main` in place now races the other
builder.

```
git worktree add ../baseline origin/main
cd ../baseline && npm ci && npm run test:db   # the baseline
```

Report **before and after on the same `main`**, naming the SHA. A count measured against a
different base is not a count.

---

## 7. What each builder does at the start of a task

1. `git fetch && git checkout main && git pull`
2. **Read `docs/ai/prompts/<TASK>-prompt.md`** — in the repo, not in a chat message
3. **Read `docs/ai/schema-inventory.md`** — check nothing the prompt specifies already exists
4. If the prompt conflicts with what is on `main`, **stop and report** — do not reconcile it alone
5. Branch, build, test
6. Rebase, assign the migration timestamp, verify, open the MR
7. Report: SHA, test counts before and after with the base SHA, anything not implemented and why

---

## 8. What stays with Deepak

- every merge, in both streams
- the register
- Railway: deploys, variables, `railway config migrate`
- design decisions when a builder stops and asks
- **branch protection on `main`** — still not set, and with two builders and a UI team it is
  now the single highest-value ten minutes available

---

## 9. Guard rails — what to do when something goes wrong

Each of these has happened in this project. The rule is the lesson.

### A builder hits a conflict with the other stream

**Stop. Do not resolve a conflict in the other stream's files.** Report which files, which
stream owns them, and what you were trying to do. Deepak decides whether to sequence the two
tasks or change one.

Resolving someone else's file by guessing is how a validator gets two sets of rules.

### A rebase produces conflicts in a shared file

`package.json`, `CLAUDE.md`, the operator registry — **append-only** files. A conflict here
means someone reordered rather than appended. Take both sides, keep both additions, never
drop one. If the conflict is not a clean "both added a line", stop and report.

### The prompt disagrees with what is on `main`

**Stop and report, do not reconcile.** QREC0a's §2 specified columns that QCE1 had already
shipped; the builder stopping is what caught it. A builder who quietly bridges the gap
produces a second way of doing the same thing, and nobody finds out for a month.

### Two migrations collide

Cannot happen if §3 is followed — the timestamp is assigned at rebase. If it happens anyway,
the **second to merge renames**, re-runs the full chain from empty, and reports. Never
renumber a migration that has been deployed.

### A test that was passing now fails

Find out whether the test was right. Twice this session a test was passing for the wrong
reason — a divide-by-zero case on an accidentally series-kind formula, and a date pinned to
2026-09-12 that became a time bomb.

**Never edit an assertion to make a build green.** Change a fixture freely; changing what a
test asserts is a behaviour change and needs saying out loud.

### A build is green locally and red in CI

Replicate the CI jobs locally from `.github/workflows/ci.yml` — all three, in order, against a
clean Postgres. **Do not merge past a red gate.** We did it once, got away with it, and that
is worse than failing, because it teaches the team the gate is noise.

### A deploy does not happen

Railway deploys `main` only, gated on the GitHub check suite. A deployment stuck WAITING means
the gate has not seen a green suite. **Do not force a redeploy to get past it** — find out why
the suite did not run.

### Something must be deleted

`git stash drop`, `git stash clear`, force-push, and deleting a branch someone else is on are
all irreversible. **Stop and ask.** Use `git stash apply`, not `pop`. Measure baselines on a
worktree, never by stashing.

### A builder is asked to do something outside their stream

Decline and report. A UI branch that edits `src/identity/role-templates.ts` is the example —
an authorization change arriving without backend review. Anything outside your stream's
surface goes back to Deepak, who decides whether it becomes its own task.

---

## 10. Before development starts — the checklist

Six of these are open right now. The first three are the ones that will actually cost time.

| | Item | Owner | Status |
|---|---|---|---|
| 1 | **Protect `main`** — push: no one, merge: maintainers, 1 approval | Deepak | **open** |
| 2 | **One register, one path** — delete `task-list-4.md`, `docs/ai/task-register.md` is canonical | CLI | **open** |
| 3 | **All prompts committed** to `docs/ai/prompts/` | CLI | **open** |
| 4 | `docs/ai/schema-inventory.md` generated | CLI | **open** |
| 5 | Both builders have Railway read access and `railway link` done | Deepak | A done, B open |
| 6 | The stuck deploy cleared and 49 migrations confirmed live | Deepak | **open** |
| 7 | `CLAUDE.md` carries the two-stream rules — §3 timestamps, §4 shared files, §9 guard rails | CLI | **open** |
| 8 | Stale MRs !23–!27, !31 closed | Deepak | open |
| 9 | Both builders read `branching-and-release-model.md` and this document | both | — |

**Do not start Stream B until items 2, 3 and 7 are done.** They take one commit between them,
and without them the second builder repeats the exact confusion the first one just reported:
two registers, missing prompts, no written rules about who owns which file.

### Three things to decide, not to build

| | Decision | Blocks |
|---|---|---|
| **Incident Management** | a view over alerts and work orders (1 day), or an entity with SLA and escalation (4+) | the module's estimate |
| **OEE** | ship Availability honestly, or hold the tile until production counts have a source | QAVAIL1's framing — the task assumes Availability |
| **Second Railway environment** | when Staging gets built, and by whom | every migration rehearsal before go-live |

---

## 11. Expected effect

Stream A is the critical path, so the honest gain from a second developer is not half the
time — it is **Stream B's ten task-days running underneath Stream A's ten**, finishing them
in roughly the same elapsed time rather than twice it.

Phase 1 backend goes from roughly three weeks to roughly two, **provided the merge queue
keeps up**. If merges stall again, the second developer adds nothing except more branches
drifting behind `main`.

---

## 12. Day one

| | Builder A | Builder B |
|---|---|---|
| Prompt | `docs/ai/prompts/QREC0a-prompt.md` | `docs/ai/prompts/QPARAM1-prompt.md` |
| Branch | `feature/library-content` | `feature/tenant-parameters` |
| Then | QREC0b, QPAGE1, QREC0c | QAVAIL1, QCAT2, QCE5 |

Both start from `origin/main` after the §10 checklist commit. Neither opens
`kpi-evaluator.service.ts` until QPARAM1 has merged.
