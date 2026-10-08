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
```

## Commands

| Command | What it does |
|---|---|
| `pnpm build` | Builds every package (shared first) |
| `pnpm build:shared` | Builds only `@cafe-loyalty/shared`, which the other packages import from its `dist` |
| `pnpm typecheck` | Type-checks every package and the root config files |
| `pnpm lint` | ESLint across the repo; fails on any warning |
| `pnpm test:unit` | Vitest unit tests for every package |
| `pnpm test:e2e` | Builds the apps and runs the Playwright browser tests at phone width |
| `pnpm db:up` / `pnpm db:down` | Starts or stops the local PostgreSQL container |
| `pnpm --filter @cafe-loyalty/server dev` | Runs the API server with reload, reading `.env` |
| `pnpm --filter @cafe-loyalty/server start` | Runs the built API server (`dist/main.js`); needs the environment set |
| `pnpm --filter @cafe-loyalty/worker dev` | Runs the background worker with reload, reading `.env` |
| `pnpm --filter @cafe-loyalty/worker start` | Runs the built worker (`dist/main.js`); needs the environment set |
| `pnpm --filter @cafe-loyalty/counter dev` | Runs the counter app dev server |
| `pnpm --filter @cafe-loyalty/counter preview` | Serves the built counter app |
| `pnpm --filter @cafe-loyalty/dashboard dev` | Runs the owner dashboard dev server |
| `pnpm --filter @cafe-loyalty/dashboard preview` | Serves the built dashboard |

Every package also has `build` and `typecheck` scripts, which the root commands run.

## Layout

| Path | Package | Role |
|---|---|---|
| `packages/shared` | `@cafe-loyalty/shared` | Code shared by every app: environment loading, log redaction |
| `apps/server` | `@cafe-loyalty/server` | Fastify API server |
| `apps/worker` | `@cafe-loyalty/worker` | Background worker |
| `apps/counter` | `@cafe-loyalty/counter` | Counter web app used by baristas (Vite, React) |
| `apps/dashboard` | `@cafe-loyalty/dashboard` | Owner dashboard (Vite, React) |
| `e2e` | | Playwright browser tests |
| `compose.dev.yaml` | | Local development database |

## Configuration

Every setting comes from environment variables; `.env.example` lists all of them, with optional ones commented out at their defaults. Each app validates its environment at start-up and exits with the names of any missing or invalid variables, never their values.
