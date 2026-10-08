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
pnpm --filter @cafe-loyalty/server build
pnpm --filter @cafe-loyalty/server create-invite --cafe-name "Test Café"   # prints a single-use owner signup link
```

To try the dashboard against the API locally, set `DASHBOARD_API_PROXY=http://127.0.0.1:3000` in `.env`, then run the server and the dashboard dev servers (see Commands) and open `http://localhost:5173`. The session cookie is `Secure`, which browsers allow on `localhost` (use `localhost`, not `127.0.0.1`, as `DASHBOARD_URL`).

## Commands

| Command | What it does |
|---|---|
| `pnpm test` | The full gate: typecheck, lint, migration check, unit tests, database tests, then browser tests; stops at the first failure. CI runs this on every pull request and push to `main` |
| `pnpm build` | Builds every package (shared first) |
| `pnpm build:packages` | Builds `@cafe-loyalty/shared` and `@cafe-loyalty/db`, which the apps import from their `dist` |
| `pnpm typecheck` | Type-checks every package and the root config files |
| `pnpm lint` | ESLint across the repo; fails on any warning |
| `pnpm test:unit` | Vitest unit tests for every package |
| `pnpm test:db` | Integration tests against PostgreSQL (`TEST_DATABASE_ADMIN_URL`): the database package and the server's API; each test file creates and drops its own database and roles |
| `pnpm check:migrations` | Static migration check: expand migrations never drop or rename tables or columns, contract migrations name a release in history, and (with `MIGRATIONS_BASE_REF`) existing migrations are unchanged |
| `pnpm test:e2e` | Builds the apps and runs the Playwright browser tests at phone width |
| `pnpm db:up` / `pnpm db:down` | Starts or stops the local PostgreSQL container |
| `pnpm db:bootstrap` | Creates or corrects the roles, the application database and its schemas (idempotent; needs `DATABASE_ADMIN_URL` and the role settings) |
| `pnpm db:migrate` | Applies pending migrations as the migrator role (`MIGRATOR_DATABASE_URL`) |
| `pnpm --filter @cafe-loyalty/server dev` | Runs the API server with reload, reading `.env` |
| `pnpm --filter @cafe-loyalty/server start` | Runs the built API server (`dist/main.js`); needs the environment set |
| `pnpm --filter @cafe-loyalty/server create-invite --cafe-name "<name>"` | Creates a café and prints a single-use owner signup link (valid 7 days); `--cafe-id <id>` instead issues a new link for an existing café. Needs `DATABASE_URL` and `DASHBOARD_URL`, and a built server. On a server, run it in a throwaway container so its output is not kept in container logs: `docker compose run --rm server node dist/create-invite-cli.js --cafe-name "<name>"` |
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
- **Tenant isolation.** Every table has forced row-level security that shows and accepts only the rows of the café set for the current transaction. Code reaches the database only through `withCafe(db, cafeId, work)`, with a café id taken from the authenticated session, device or job, never from request input. Before any café is known (signing in, opening an invite or reset link, checking a session cookie), `withLookup(db, key, work)` runs a read-only transaction that shows only the owner with a given email or the session, invite or reset token with a given SHA-256 hash; the café id it finds is then used with `withCafe`. The one place a café id is created rather than looked up is the operator's `create-invite` command, which creates the café.
- **Migrations.** Plain SQL files in `packages/db/migrations`, numbered `0001_...sql`, each starting with `-- migration: expand` (adds only, safe for the previous release) or `-- migration: contract` plus `-- requires-deployed: <commit>` (removes or renames, only once the deployed release no longer uses it). Applied migrations are never edited; the runner refuses a changed file and refuses to run an older release on a newer database.

## Owner accounts

- **Invite only.** The operator runs `create-invite`, which creates the café and prints a single-use signup link (`/signup#invite=…`, valid 7 days). The link is a secret until used: send it to the owner directly, never in a shared channel or a ticket. The owner opens it, chooses an email and a password (at least 10 characters) and is signed in. Tokens in links sit in the URL fragment, which browsers never send to a server.
- **Passwords** are hashed with argon2id (19 MiB, 2 passes). Sign-in answers a wrong password and an unknown email identically.
- **Sessions** are server-side rows keyed by the SHA-256 hash of a random 256-bit token sent as a `__Host-` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`). They end after 7 days idle or 30 days in all. Signing out, changing the password and resetting it end every session of the owner. The API accepts JSON bodies only, so a cross-site form cannot post to it.
- **Password reset** emails a single-use link (`/reset-password#token=…`) valid 30 minutes; only the newest link works. The reply is the same, and sent before any lookup, whether or not the email has an account.
- **Rate limits** (per server process, reset on restart; an IPv6 client counts by its /64 network): sign-in 30 attempts per 15 minutes per IP, and failed attempts only: 10 per 15 minutes per account and IP, 100 per hour per account; reset requests 5 per hour per IP and 3 per email; reset completion 10 per 15 minutes per IP; signup 10 per hour per IP; password change 10 per 15 minutes per owner. In production the server refuses to start unless `TRUST_PROXY_HOPS` is set (1 behind Caddy) and `DASHBOARD_URL` is https.

## Continuous integration

`.github/workflows/ci.yml` runs `pnpm test` on Ubuntu with the Node version from `.nvmrc`, a frozen lockfile, Playwright Chromium and a PostgreSQL 18 service container (trust authentication, reachable only from the job). It has read-only repository permissions, pins every action to a commit SHA, and uploads the Playwright report when a run fails.

## Configuration

Every setting comes from environment variables; `.env.example` lists all of them, with optional ones commented out at their defaults. Each app validates its environment at start-up and exits with the names of any missing or invalid variables, never their values.
