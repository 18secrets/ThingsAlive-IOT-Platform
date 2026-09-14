# Deploying Platform 2.0

Two services, one database, one Railway project per environment. This is the order to
do it in and the reasoning behind the parts that are not obvious.

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

## Migrations

`railway.json` sets `preDeployCommand: npm run migration:run` on the **api service
only**. Railway runs it once, before the new version takes traffic.

Three things follow from that, and each is a failure avoided:

- **Not at application boot.** Three replicas booting together would race to migrate
  the same schema.
- **Not from CI.** CI runs before the deploy, so the schema would move while the old
  code was still serving it.
- **Not on both services.** The scheduler has no `preDeployCommand`; if it did, the two
  would race and the loser would find the schema already moved.

Migrations run as `DB_USERNAME`, which must own the schema. Requests run as `ta_app`,
which is unprivileged and cannot bypass row-level security. That separation is the
whole tenancy guarantee — see `src/scope/tenant-session.ts`.

## First deploy, in order

1. **Provision.** One Railway project per environment. Add Postgres from the template.
2. **Create the `ta_app` role's owner.** Nothing to do: the RLS migration creates the
   role. But `DB_USERNAME` must own the schema, or the migration cannot grant on it.
3. **Set the variables** (below). Database URL comes from Railway's own reference
   between services; secrets come from your vault, never from the repository.
4. **Deploy `api` first.** Its pre-deploy command builds the schema the scheduler needs.
5. **Deploy `scheduler`** with `SHIFT_RUNNER_ENABLED=true`.
6. **Watch `/api/v1/ready`.** It checks the database. Railway holds the old deployment
   until it answers, so a service that boots but cannot reach Postgres never takes
   traffic.

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

| Environment | Deploys from | Data | Who can push |
|---|---|---|---|
| staging | the `integration` branch, automatically | a restored, anonymised production-shaped dump | CI only |
| production | the default branch, **manually** | live tenant data, daily backups | CI only, with an approval step |

Production is `when: manual` in `.gitlab-ci.yml`. That is the human in the loop, and it
is the only thing between a green pipeline and a release.

## What is not done yet

- **`package-lock.json` is not in the repository** (`P0-17`). The Dockerfile uses
  `npm ci`, which requires it — so the image cannot build until it is committed. This
  is one `git add` from a machine with the repo checked out.
- **Railway is not connected to this workspace**, so the project, services and
  variables have to be created by hand the first time. The CLI commands in
  `.gitlab-ci.yml` take over after that.
- **No smoke suite runs after a deploy.** The readiness probe proves the process can
  reach its database; it does not prove a tenant can sign in and read a prediction.
