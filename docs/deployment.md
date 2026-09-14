# Deploying Platform 2.0

Two services, one database, one Railway project per environment. Releases are
automatic; the only thing anyone types is `git tag`.

## How a commit becomes a release

Railway connects to GitHub only. GitLab stays the source of truth — merge requests are
reviewed here — and push-mirrors every commit to a GitHub remote that Railway watches.
The mirror is invisible once it is set up; it costs nothing and uses no CI minutes.

```
merge to main ──▶ GitHub checks (.github/workflows/ci.yml) ──▶ Railway deploys STAGING
tag v1.2.0    ──▶ promote.yml moves `production` ──▶ checks ──▶ Railway deploys PRODUCTION
```

Both Railway services have **Wait for CI** enabled, so a push sits in `WAITING` until
every check suite on that commit finishes, and a red one never deploys. That setting is
what makes the automation safe rather than merely fast.

Two consequences worth knowing before something confuses you:

- **Every branch a Railway service watches must appear in `ci.yml`'s push triggers.**
  If it does not, the deployment waits for checks that never arrive and the only symptom
  is that releases silently stopped. `test/deployment.spec.ts` asserts this.
- **Tags do not deploy; branches do.** `promote.yml` turns a `v*` tag into a move of the
  `production` branch, and refuses to promote a commit that is not an ancestor of `main`
  — otherwise a tag on a feature branch releases unmerged code and looks deliberate.

## The shape

| Service | What it is | Replicas | Scales on |
|---|---|---|---|
| `api` | NestJS HTTP. Serves `/api/v1`, runs migrations before traffic. | 1+ | Request volume |
| `scheduler` | The same image with `SHIFT_RUNNER_ENABLED=true`. Runs the shift pass. | **Exactly 1** | Nothing — it is a singleton |

Both build from the same `Dockerfile` and run the same `dist/main.js`. The only thing
that distinguishes them is one environment variable, which is deliberate: two images
would drift, and the day they drifted would be the day the scheduler scored a shift
with last month's code.

**The scheduler is one replica on purpose.** The pass takes a Postgres advisory lock,
so a second instance is harmless rather than dangerous — but it would double the work
and halve the sense the logs make at exactly the moment somebody is reading them to
find out why a machine was not scored.

## The config files, and why the dashboard is authoritative

`railway.json` and `railway.scheduler.json` describe what each service must be. They are
no longer *read* by Railway: Config-as-Code was deprecated on 2026-08-28, and a service
created after that date cannot opt in — existing users keep working until 2026-12-01.

They stay in the repository anyway, as the specification. Every value below is asserted
against the application by `test/deployment.spec.ts` — the healthcheck path against the
live router, the pre-deploy command against `package.json`'s scripts — so the file is
still what catches a rename. What changed is only who applies it: you do, once, in the
dashboard.

**Set these by hand on each service** (Settings → Deploy, and Settings → Scale):

| Setting | `api` | `scheduler` |
|---|---|---|
| Healthcheck Path | `/api/v1/ready` | `/api/v1/ready` |
| Pre-deploy step | `npm run migration:run` | **empty** |
| Replicas | 1+ | **exactly 1** |
| Restart policy | On Failure, bounded | On Failure, bounded |

If Railway's Infrastructure-as-Code replacement is adopted later, these files are the
content to port; nothing about them was wrong, only how they were delivered.

## Migrations

The **api service only** carries the pre-deploy step `npm run migration:run`. Railway
runs it once, before the new version takes traffic.

Three things follow from that, and each is a failure avoided:

- **Not at application boot.** Three replicas booting together would race to migrate
  the same schema.
- **Not from CI.** CI runs before the deploy, so the schema would move while the old
  code was still serving it.
- **Not on both services.** The scheduler's pre-deploy step is empty; if it were not,
  the two would race and the loser would find the schema already moved. Since this is
  now a dashboard setting rather than a committed file, it is the one piece of the
  deployment no test can guard — check it whenever a service is recreated.

Migrations run as `DB_USERNAME`, which must own the schema. Requests run as `ta_app`,
which is unprivileged and cannot bypass row-level security. That separation is the
whole tenancy guarantee — see `src/scope/tenant-session.ts`.

## First deploy, in order

Once. After this, releases need none of it.

1. **Mirror GitLab to GitHub.** Create an empty private GitHub repository. In GitLab:
   Settings → Repository → Mirroring repositories, URL `https://github.com/ORG/REPO.git`,
   your GitHub username and a fine-grained personal access token with `Contents: write`.
   Mirroring is on the Free tier and consumes no CI minutes.
2. **Provision.** One Railway project per environment. Add Postgres from the template.
3. **Create `api` and `scheduler`**, both from the GitHub repository, then apply the
   dashboard settings in the table above — the pre-deploy step on `api` and nowhere
   else, one replica on `scheduler`. `DB_USERNAME` must own the schema, or the migration
   cannot grant on it; the RLS migration creates the `ta_app` role itself.
4. **Set the trigger branch and turn on Wait for CI** on both services: `main` in the
   staging project, `production` in the production project.
5. **Set the variables** (below). Database values come from Railway's own reference
   between services; secrets come from your vault, never from the repository.
6. **Push to `main`.** Nothing else. The checks run, `api` deploys and its pre-deploy
   command applies the migrations before traffic moves, then `scheduler` deploys.
7. **Watch `/api/v1/ready`.** It asks each dependency rather than describing them, and
   Railway holds the old deployment until it answers 200 — so a service that boots but
   cannot reach Postgres never takes traffic. Two answers are both 200 and they mean
   different things:

   - `status: "ok"` — everything answered.
   - `status: "degraded"` — the platform database answered and the legacy connection
     did not, or is not configured yet. The release proceeds deliberately: gating our
     deploys on the existing platform's database would let their maintenance window
     block our releases, and scoring already waits — the shift windows stay owed and
     are taken when a route comes back.

   `status: "not_ready"` is 503 and only the platform's own database can cause it. The
   body carries the per-dependency checks in every case, so the failing one is named.
8. **Release to production** with `git tag v1.0.0 && git push origin v1.0.0`.

## Variables

Everything in `.env.example` is real and read somewhere; a test asserts that the file
names every variable the code reads, so it cannot drift.

The ones whose absence is silent rather than loud:

- **`LEGACY_DB_*`** — unset means telemetry is never pulled. The runner says so every
  pass and nothing is lost (every window stays owed), but nothing is scored either.
  The credentials must be **read-only**: the connection is opened with
  `default_transaction_read_only=on`, so Postgres refuses a write whatever the code
  asks for, but a read-only grant upstream is the belt to that brace.
- **`SHIFT_RUNNER_ENABLED`** — false or unset on `api`, true on `scheduler`. Wrong on
  both and nothing ever scores; wrong on `api` and every replica ticks.
- **`DB_APP_ROLE`** — leave it alone. The service refuses to connect if the role does
  not exist, which is deliberate: falling back to the login user would disable
  row-level security silently, and a managed Postgres hands out a superuser.

## Rollback

Railway keeps the previous deployment; redeploying it is one action. What is **not**
automatic is the schema.

A migration with a tested `down` path can be reverted with `npm run migration:revert`,
and every migration in this repo has one — the migration test runs up, down and up
again on every commit. But reverting a migration that dropped a column does not bring
the data back. **Rehearse the rollback on staging before the first production release**
and write down how long it took.

## Environments

| Environment | Deploys when | Data | Trigger |
|---|---|---|---|
| staging | `main` moves and the checks pass | a restored, anonymised production-shaped dump | every merge |
| production | the `production` branch moves and the checks pass | live tenant data, daily backups | `git tag v*` |

Merging to `main` is a decision about the code. Releasing to tenants with live data is a
second decision, and the tag is the smallest possible way to make it deliberately — one
command, nothing to click, no dashboard. `promote.yml` is the only thing that ever moves
the `production` branch, and it refuses a commit that is not already on `main`.

## What is not done yet

- **`package-lock.json` is not in the repository** (`P0-17`). The Dockerfile uses
  `npm ci`, which requires it — so the image cannot build until it is committed. This
  is one `git add` from a machine with the repo checked out.
- **Railway is not connected to this workspace**, so the mirror, the project, the
  services and the variables have to be created by hand the first time. After that
  nothing is manual: the release path above runs itself.
- **No smoke suite runs after a deploy.** The readiness probe proves the process can
  reach its database; it does not prove a tenant can sign in and read a prediction.
