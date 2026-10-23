# Branching, environments and the path to go-live

2026-10-05. Records decisions already taken, and names what is still missing before a
customer can use this.

---

## 1. What is actually true today

**One repository.** `things-alive-2.0/things-alive-iot-platform-2.0`, push-mirrored to GitHub
`18secrets/ThingsAlive-IOT-Platform`.

```
/                 NestJS API, migrations, tests
/frontend         React + Vite console          ← the UI team's area
/docs/ai          decisions, task register, analyses
```

There is **no separate frontend repository and no permanent UI branch.**
`feature/bulk-classes` and `feature/clientflow` are ordinary short-lived feature branches.

**Four Railway services, one environment (Development):**

| Service | Source | URL |
|---|---|---|
| Githubrepo API | `main`, root | `api-development-154e.up.railway.app` |
| scheduler | `main`, root | — (no public domain) |
| Frontend | `main`, `frontend/` | `frontend-ui-thingsalive-iot-platform-development.up.railway.app` |
| Frontend - preview | `feature/bulk-classes`, `frontend/` | `frontend-preview-development.up.railway.app` |
| Postgres | — | internal only |

**Deploy chain:** GitLab merge → push mirror → GitHub Actions CI → Railway "Wait for CI" →
deploy. Railway deploys **one branch per service**, and every real service watches `main`.

---

## 2. Why one repository, not two

The UI's contract *is* the API's shape. When an endpoint changes, the screen that calls it
changes in the same breath.

| One repo | Two repos |
|---|---|
| one commit carries the API change and the screen that uses it | two PRs, two merges, two deploys, in an order someone has to remember |
| CI proves them together | each proves itself; the pair is proved in Development, by a customer |
| one answer to "what is deployed" | two answers that drift |

We already lived the failure this prevents. The Catalog Import screen on
`feature/bulk-classes` was written before QIMP4 and QIMP5. It is now **31 commits behind** and
its import flow cannot complete — it has no sensor approval step, because that step did not
exist when the branch was cut. In one repository that shows up as a rebase. In two
repositories it shows up as a customer stuck on a screen.

**Separate repositories become right when the UI stops tracking the API** — a public site, a
mobile app on its own release cycle, a white-label shell. Not before.

---

## 3. Why the UI team works on branches, not on `main`

Pushing UI straight to `main` would reach Development in minutes. It is still wrong:

1. **`main` is what the library team is using.** A broken screen interrupts content loading
   mid-upload, with no review.
2. **A red `main` blocks the backend too.** CI runs on `main` and Railway refuses every
   deploy behind a failed check suite. One bad UI push stalls everyone — that has already
   cost five days once, from a single misconfigured job.
3. **No record.** `main` is the only answer to "what is live". Direct pushes mean no diff, no
   author, no reason.

**The preview service exists so the trade costs nothing.** Push to the feature branch, the
preview URL updates in a minute or two. Hosted link, no merge, no shared blast radius.

| Purpose | Use |
|---|---|
| Daily development | local `npm run dev` against the Development API |
| Showing work | the preview URL |
| Reaching Development | merge to `main` through CI — **no shortcut exists** |

**Branches are short-lived.** A UI branch that lives three weeks is the defect, not the
process. Rebase onto `main` daily; merge when a slice works.

---

## 4. Environments at go-live

Today there is **one** environment and it is called Development, which means it is
simultaneously the integration environment, the demo environment and the only database.
That cannot carry a customer.

| Environment | Branch | Database | Who uses it | Data |
|---|---|---|---|---|
| **Development** | `main` | dev Postgres | engineers, library team, UI team | throwaway, may be wiped |
| **Staging** | `release/*` tag | **its own** Postgres, production-shaped | QA, migration rehearsal, customer demos | realistic volume, no real customer data |
| **Production** | the same tag, promoted | production Postgres | customers | real |

**Staging is not optional, and its job is one thing above all: rehearsing migrations against
production-sized data.** Railway runs `preDeployCommand: npm run migration:run` before the
container starts, inside a transaction. A migration that takes four minutes is a four-minute
outage. The only way to know is to have run it on data the size of production's.

---

## 5. Promotion — the same build, moved

**Never rebuild from a branch to promote.** A rebuild is a different artifact and proves
nothing about what was tested.

```
main (CI green)  →  tag v1.4.0  →  Staging deploys that tag
                                      ↓  QA + migration timing
                                   Production deploys the same tag
```

| Step | Who | Gate |
|---|---|---|
| merge to `main` | maintainer | CI green, MR approved |
| tag a release | maintainer | Development healthy |
| deploy to Staging | automatic on tag | CI green |
| QA on Staging | test team | the 48-case plan passes |
| **deploy to Production** | **manual, named person** | QA signed off, migration timing known |

Production never deploys automatically. The gate is a person, deliberately.

---

## 6. Migrations in production — the part that needs discipline

Migrations do not roll back. Railway's rollback restores the previous container, not the
previous schema. So:

- **Expand, then contract.** Add a nullable column, deploy, backfill, deploy, and only then
  make it NOT NULL in a later release. Never in one step on a live table.
- **Seed before you migrate** — in tests too. `1758020000000` ran `UPDATE` before
  `DROP NOT NULL`, passed every local suite because the tables were empty, and failed on the
  first database that had a row.
- **Time it on Staging.** Over ~30 seconds and it does not belong in `preDeployCommand`.
- **Forward-only fixes.** A bad migration in production is corrected by the next migration,
  not by a down path.

---

## 7. What is missing before go-live

| | Item | Owner |
|---|---|---|
| 1 | **Protect `main`** — push: no one, merge: maintainers, 1 approval | Deepak, two clicks, still open |
| 2 | **A Staging environment** — own Postgres, own domains, own secrets | not started |
| 3 | **A Production environment** — own Postgres, backups, retention, restore **tested** | not started |
| 4 | **QOPS1** — `railway.json` is deprecated and stops working **2026-12-01**, taking `preDeployCommand` and the CI gate with it | before end of October |
| 5 | **Decide the GitHub mirror's visibility** — currently public: backend, docs, architecture | Deepak |
| 6 | **Per-environment secrets** — no shared JWT secret, no shared database credential | with item 2 |
| 7 | **Migration timing rehearsal** at production data volume | with item 2 |
| 8 | **Restore drill** — a backup nobody has restored is not a backup | with item 3 |
| 9 | **CORS per environment** — each frontend origin allowed only on its own API | with item 2 |
| 10 | **Release tagging** and a written promotion checklist | with item 2 |

Items 2 and 3 are the large ones. Everything else is hours.

---

## 8. Rules in force now

1. `main` moves only through a merge request, approved, CI green.
2. Feature branches are short-lived and rebased onto `main` daily.
3. Railway deploys `main` only; the preview service is for showing work and is never promoted.
4. No force-push to `main`, `feature/dev`, `integration` or `production`.
5. Deploys and environment variables belong to Deepak; the CLI reads Railway, never writes.
6. One commit carries the API change and the UI that uses it.
