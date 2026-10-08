# Cafe Loyalty

A cash-first loyalty tool for independent cafés in Tripoli, Lebanon. Customers get a phone-number loyalty card in Apple Wallet, Google Wallet or a web card; baristas add stamps from an offline-capable counter app; owners see busy and quiet hours, win back lapsed regulars and run quiet-hour offers that never discount below a margin floor.

## Requirements

- Node.js 22 (see `.nvmrc`)
- pnpm 11.24, enabled through Corepack: `corepack enable`
- Docker with Compose, for the local PostgreSQL database

## Setup

```sh
cp .env.example .env        # then set a local POSTGRES_PASSWORD
pnpm install
pnpm exec playwright install chromium
pnpm db:up                  # starts PostgreSQL on 127.0.0.1 and waits until it is healthy
pnpm db:bootstrap           # creates the roles, the application database and its schemas
pnpm db:migrate             # applies the migrations
```

## Commands

| Command | What it does |
|---|---|
| `pnpm test` | The full gate: typecheck, lint, migration check, unit tests, database tests, then browser tests; stops at the first failure. CI runs this on every pull request and push to `main` |
| `pnpm build` | Builds every package (shared first) |
| `pnpm build:shared` | Builds only `@cafe-loyalty/shared`, which the other packages import from its `dist` |
| `pnpm typecheck` | Type-checks every package and the root config files |
| `pnpm lint` | ESLint across the repo; fails on any warning |
| `pnpm test:unit` | Vitest unit tests for every package |
| `pnpm test:db` | Database integration tests against PostgreSQL (`TEST_DATABASE_ADMIN_URL`); each test file creates and drops its own database and roles |
| `pnpm check:migrations` | Static migration check: expand migrations never drop or rename tables or columns, contract migrations name a release in history, and (with `MIGRATIONS_BASE_REF`) existing migrations are unchanged |
| `pnpm test:e2e` | Builds the apps and runs the Playwright browser tests at phone width |
| `pnpm db:up` / `pnpm db:down` | Starts or stops the local PostgreSQL container |
| `pnpm db:bootstrap` | Creates or corrects the roles, the application database and its schemas (idempotent; needs `DATABASE_ADMIN_URL` and the role settings) |
| `pnpm db:migrate` | Applies pending migrations as the migrator role (`MIGRATOR_DATABASE_URL`) |
| `pnpm --filter @cafe-loyalty/server dev` | Runs the API server with reload, reading `.env` |
| `pnpm --filter @cafe-loyalty/server start` | Runs the built API server (`dist/main.js`); needs the environment set |
| `pnpm --filter @cafe-loyalty/worker dev` | Runs the background worker with reload, reading `.env` |
| `pnpm --filter @cafe-loyalty/worker start` | Runs the built worker (`dist/main.js`); needs the environment set |
| `pnpm --filter @cafe-loyalty/counter dev` | Runs the counter app dev server |
| `pnpm --filter @cafe-loyalty/counter preview` | Serves the built counter app |
| `pnpm --filter @cafe-loyalty/dashboard dev` | Runs the owner dashboard dev server |
| `pnpm --filter @cafe-loyalty/dashboard preview` | Serves the built dashboard |

Every package also has `build` and `typecheck` scripts, which the root commands run. `@cafe-loyalty/db` also has `bootstrap`, `migrate` and `check-migrations`, which the root `db:*` and `check:migrations` commands run after building it.

## Layout

| Path | Package | Role |
|---|---|---|
| `packages/shared` | `@cafe-loyalty/shared` | Code shared by every app: environment loading, log redaction, error codes, money, time, sync wire format |
| `packages/db` | `@cafe-loyalty/db` | Database: migrations, bootstrap, the café-scoped query helper, schema types (server and worker only) |
| `apps/server` | `@cafe-loyalty/server` | Fastify API server |
| `apps/worker` | `@cafe-loyalty/worker` | Background worker |
| `apps/counter` | `@cafe-loyalty/counter` | Counter web app used by baristas (Vite, React) |
| `apps/dashboard` | `@cafe-loyalty/dashboard` | Owner dashboard (Vite, React) |
| `e2e` | | Playwright browser tests |
| `compose.dev.yaml` | | Local development database |

## Database

PostgreSQL 18. Everything lives in schema `app`; migration history is in `meta.schema_migrations`.

- **Roles.** `cl_owner` owns every object and is used only by migrations; `cl_app` holds the runtime privileges. Neither can log in. Each environment has two login roles: a migrator that is a member of `cl_owner`, and an app role that is a member of `cl_app` only. No role has superuser or BYPASSRLS. Bootstrap sets passwords as SCRAM verifiers, so plaintext never reaches the server or its logs. The group roles are cluster-wide, so staging and production each run their own PostgreSQL server.
- **Tenant isolation.** Every table has forced row-level security that shows and accepts only the rows of the café set for the current transaction. Code reaches the database only through `withCafe(db, cafeId, work)`, with a café id taken from the authenticated session, device or job, never from request input.
- **Migrations.** Plain SQL files in `packages/db/migrations`, numbered `0001_...sql`, each starting with `-- migration: expand` (adds only, safe for the previous release) or `-- migration: contract` plus `-- requires-deployed: <commit>` (removes or renames, only once the deployed release no longer uses it). Applied migrations are never edited; the runner refuses a changed file and refuses to run an older release on a newer database.

## Continuous integration

`.github/workflows/ci.yml` runs `pnpm test` on Ubuntu with the Node version from `.nvmrc`, a frozen lockfile, Playwright Chromium and a PostgreSQL 18 service container (trust authentication, reachable only from the job). It has read-only repository permissions, pins every action to a commit SHA, and uploads the Playwright report when a run fails.

## Configuration

Every setting comes from environment variables; `.env.example` lists all of them, with optional ones commented out at their defaults. Each app validates its environment at start-up and exits with the names of any missing or invalid variables, never their values.
