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

`PUBLIC_URL` is this server's own public address, used in café signup QR codes and recovery links. `COUNTER_URL` is the counter app's address (no path; `http://localhost:5174` locally, https in production): pairing QR codes open its `/pair` page. To try the dashboard against the API locally, set `DASHBOARD_API_PROXY=http://127.0.0.1:3000` in `.env`, then run the server and the dashboard dev servers (see Commands) and open `http://localhost:5173`; `COUNTER_API_PROXY` does the same for the counter app (`http://localhost:5174`, started with `--port 5174`). The session cookie is `Secure`, which Chrome and Firefox allow on `http://localhost` (Safari does not; use Chrome or Firefox locally, and `localhost`, not `127.0.0.1`, as `DASHBOARD_URL`). Without SMTP credentials locally, leave `SMTP_USER` and `SMTP_PASSWORD` unset and point `SMTP_HOST`/`SMTP_PORT` at a mail catcher such as Mailpit; the server checks the SMTP connection at startup and logs an error if it fails.

## Commands

| Command | What it does |
|---|---|
| `pnpm test` | The full gate: typecheck, lint, migration check, unit tests, database tests, then browser tests; stops at the first failure. CI runs this on every pull request and push to `main` |
| `pnpm build` | Builds every package (shared first) |
| `pnpm build:packages` | Builds `@cafe-loyalty/shared` and `@cafe-loyalty/db`, which the apps import from their `dist` |
| `pnpm typecheck` | Type-checks every package and the root config files |
| `pnpm lint` | ESLint across the repo; fails on any warning |
| `pnpm test:unit` | Vitest unit tests for every package |
| `pnpm test:db` | Integration tests against PostgreSQL (`TEST_DATABASE_ADMIN_URL`): the database package and the server's API, including the sync contract test that replays the frozen counter fixtures; each test file creates and drops its own database and roles |
| `pnpm check:migrations` | Static migration check: expand migrations never drop or rename tables or columns, contract migrations name a release in history, and (with `MIGRATIONS_BASE_REF`) existing migrations are unchanged |
| `pnpm test:e2e` | Builds the apps and runs the Playwright browser tests at phone width |
| `pnpm db:up` / `pnpm db:down` | Starts or stops the local PostgreSQL container |
| `pnpm db:bootstrap` | Creates or corrects the roles, the application database and its schemas (idempotent; needs `DATABASE_ADMIN_URL` and the role settings) |
| `pnpm db:migrate` | Applies pending migrations as the migrator role (`MIGRATOR_DATABASE_URL`) |
| `pnpm --filter @cafe-loyalty/server dev` | Runs the API server with reload, reading `.env` |
| `pnpm --filter @cafe-loyalty/server start` | Runs the built API server (`dist/main.js`); needs the environment set |
| `pnpm --filter @cafe-loyalty/server create-invite --cafe-name "<name>"` | Creates a café and prints a single-use owner signup link (valid 7 days); `--cafe-id <id>` instead issues a new link for an existing café. Needs `DATABASE_URL` and `DASHBOARD_URL`, and a built server. On a server, run it in a throwaway container so its output is not kept in container logs: `docker compose run --rm server node dist/create-invite-cli.js --cafe-name "<name>"` |
| `pnpm --filter @cafe-loyalty/server freeze-sync-fixture <name>` | Writes `apps/server/sync-fixtures/<name>.json`: the sync requests this counter build sends and the answers they must keep getting. Run it for every counter release with `BUILD_ID` and `BUILT_AT` set as the release sets them; never edit a fixture once its release has shipped |
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
- **Tenant isolation.** Every table has forced row-level security that shows and accepts only the rows of the café set for the current transaction. Code reaches the database only through `withCafe(db, cafeId, work)`, with a café id taken from the authenticated session, device or job, never from request input. Before any café is known (signing in, opening an invite or reset link, checking a session cookie), `withLookup(db, key, work)` runs a transaction (read-only unless asked otherwise) that shows only the rows matching what the caller holds: an owner's email, a token or secret hash, a device key id; the café id it finds is then used with `withCafe`. The one place a café id is created rather than looked up is the operator's `create-invite` command, which creates the café.
- **Job queue.** pg-boss, in schema `pgboss`, created by migration `0007` (never by pg-boss itself): the app role reads and writes jobs and calls pg-boss's functions but cannot create or alter anything, and pg-boss runs with its schema migration, reindexing and stored statistics off. The worker refuses to start on a pg-boss schema version other than its library's; a pg-boss upgrade that changes it needs a migration made from `getMigrationPlans`. Every hour the worker removes expired owner sessions (including idle ones), reset links, invites, device tokens, pairing codes and card recovery links through `purge_expired_credentials()`, which runs as the owner role and sees only expired rows.
- **Migrations.** Plain SQL files in `packages/db/migrations`, numbered `0001_...sql`, each starting with `-- migration: expand` (adds only, safe for the previous release) or `-- migration: contract` plus `-- requires-deployed: <commit>` (removes or renames, only once the deployed release no longer uses it). Applied migrations are never edited; the runner refuses a changed file and refuses to run an older release on a newer database.

## Owner accounts

- **Invite only.** The operator runs `create-invite`, which creates the café and prints a single-use signup link (`/signup#invite=…`, valid 7 days). The link is a secret until used: send it to the owner directly, never in a shared channel or a ticket. The owner opens it, chooses an email and a password (at least 10 characters) and is signed in. Tokens in links sit in the URL fragment, which browsers never send to a server.
- **Passwords** are hashed with argon2id (19 MiB, 2 passes). Sign-in answers a wrong password and an unknown email identically.
- **Sessions** are server-side rows keyed by the SHA-256 hash of a random 256-bit token sent as a `__Host-` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`). They end after 7 days idle or 30 days in all. Signing out, changing the password and resetting it end every session of the owner. Every write must carry a JSON body (`{}` when empty), so a cross-site page, even on a sibling subdomain, cannot post to it.
- **Password reset** emails a single-use link (`/reset-password#token=…`) valid 30 minutes; only the newest link works, and the email says so. Completing a reset lifts any sign-in lockout on the account. Passwords are compared in Unicode NFKC form and their length is counted in characters. Sign-in emails must be in Latin letters. The reply is the same, and sent before any lookup, whether or not the email has an account.
- **Rate limits** (per server process, reset on restart; an IPv6 client counts by its /64 network): sign-in 30 attempts per 15 minutes per IP, and failed attempts only: 10 per 15 minutes per account and IP, 100 per hour per account; reset requests 5 per hour per IP and 3 per email; reset completion 10 per 15 minutes per IP; signup 10 per hour per IP; password change 10 per 15 minutes per owner; setting PINs (adding a barista or changing a PIN) 30 per hour per owner; pairing codes 20 per hour per owner; failed pairings 10 and failed token renewals 30 per 15 minutes per IP (failures only, because counters share the café's Wi-Fi address with customers); renewals 30 per hour per device; syncs 240 per hour per device. In production the server refuses to start unless `TRUST_PROXY_HOPS` is set (1 behind Caddy) and `DASHBOARD_URL` is https.

## Café setup, staff and devices

- **Café.** The owner sets the café's name, the loyalty program (stamps for a reward, reward name in Arabic and English) and order types (names in both languages, USD price and cost in cents, stamps earned, on sale or not). Adding an order type or changing a price or cost bumps the café's catalog version. Every change is in the audit log.
- **Staff.** The owner adds each barista with a PIN of 6 to 12 digits (no repeated digit or straight run) and tells it to them. The server keeps only a salted PBKDF2-SHA256 hash (600,000 iterations), which paired phones receive to check PINs offline. A 6-digit PIN's hash can be cracked offline in minutes by whoever holds a paired phone, so the phone's lockout is what protects PINs: staff should not reuse a PIN from elsewhere, and longer PINs are safer. Removing a barista keeps their record for the history.
- **Devices.** The owner creates a single-use pairing code (12 characters, `ABCD-EFGH-JKMN`, valid 10 minutes, deleted after 5 wrong tries) shown as text and as a QR that opens the counter app's `/pair` page. Pairing registers the phone's P-256 public key and issues an access token valid 1 hour; the phone renews it by signing with its key. A phone that has not renewed for 7 days must pair again. Pairing again with a new code keeps the phone's device id (it proves its old key), so what it queued still syncs; from then on only the new key renews. A removed phone is told so (`DEVICE_REVOKED`) on its next request; until its current token expires it can still hand over its queue. Changing or resetting the owner's password cancels their open pairing codes.
- **Access.** Every API route declares who may call it: the owner (session cookie), a paired device (`Authorization: Bearer`) or anyone; the server refuses to start if a route declares nothing. Owner routes answer 403 to a device token.

## Counter app and sync

- **Pairing and baristas.** The counter opens at `/pair` from the dashboard's QR (or a typed code), makes a non-extractable WebCrypto key and keeps it, the access token, the baristas' PIN hashes and its queue in IndexedDB. A barista picks their name and enters their PIN, checked on the phone; they stay signed in until someone taps Switch barista. Five wrong PINs in a row lock that barista out on that phone for 30 seconds, doubling with each further wrong PIN up to an hour; the lockout survives reloads and is reported to the owner's audit log at the next sync.
- **Offline queue.** Everything the counter records is an event signed with the device key (device, key, staff and event ids, per-device sequence, schema version, time) and kept in IndexedDB until the server answers it for good. The counter syncs on start, when it comes back online and every 30 seconds while anything waits, at most 100 events per request.
- **Sync** (`POST /api/device/sync`) answers every event on its own, by index: applied, duplicate, rejected or retry_later, with a code. The device and café come from the token, never the event; the event's key must belong to that device and its signature must verify; `occurredAt` may be at most 30 days old; an event up to a day ahead of the server's clock (a phone clock running fast) waits as retry_later once it is more than 5 minutes ahead, and further ahead is refused. A verified event is recorded once in a ledger (unique per café, device and event id): sent again it is a duplicate, and with other content under the same id it is an idempotency conflict. Unknown types or versions answer retry_later, so a counter newer than the server keeps them. The counter drops an event only on applied, duplicate or rejected, and lists rejected ones on screen until cleared. Visits become stamps as they are recorded (see Stamping and rewards).
- **Review queue.** Actions from a removed phone (or signed by a key it had when removed) and from removed baristas are neither applied nor dropped (PIN lockout reports, which change nothing, are audited at once and say where they came from): the owner accepts or discards them on the dashboard's Review page, a page of 50 at a time. A removed phone's sync answer says so (`deviceRevoked`), and the phone unpairs at once.
- **Pairing again.** The proof from the old key covers the new code and the new key, so it works once. A phone still holding another café's identity is refused (`PAIRED_ELSEWHERE`, the code stays usable): the counter warns how many items would be lost and starts over as a new device only when someone confirms (at once when nothing waits). Tokens are stored with the key they were issued for, so a renewal that finishes after the phone paired again is dropped; renewals take one Web Lock across tabs, and every tab reloads its view when another changes the stored data.
- **Builds.** Every counter request carries `X-Counter-Built-At`. The API serves new actions only to counter builds made at most 14 days before its own release (`BUILT_AT`) and answers 426 otherwise; pairing, token renewal and sync work from any build, so an old counter always drains its queue. The service worker keeps the app usable offline and installs an update only once the queue is empty and nobody is typing; the status bar always shows the connection, what waits to be sent and the build.

## Stamping and rewards

- **Visits.** A signed-in barista adds what was ordered from the menu (the order types on sale, loaded with the baristas and kept for offline use) and identifies the card: by scanning its QR with the phone's camera (read on the phone, checked offline to be this café's), or by typing the customer's mobile number. The visit is queued and synced like any event, with each item's price, cost and catalog version as the counter saw them: the server stores them and never re-prices from today's catalog.
- **Stamps.** A visit earns the sum of its items' stamps (an order type's stamps times the quantity; items that earn none add nothing). It adds no stamps, but still counts as a visit, when the card got stamps within 30 minutes of the visit's time, in either order (a database exclusion constraint enforces this), or when the counter phone has added 300 stamps that day in the café's time zone (each phone has its own cap). Every stamp is audit-logged with the device and the barista, against the visit (`visit.stamped`) and never the card; rewards likewise (`reward.redeemed`).
- **Which card.** A QR must be genuine (signed), of this café and of the card's current epoch (`CARD_REPLACED` after a recovery). A phone number finds the card only through this café's cards, and only once that card has been scanned at a counter (`PHONE_NOT_CONFIRMED` before), because numbers are not verified. A scan proves who holds the card, not whose number it is: once a second card here signs up with the same number, the linked card is never stamped by number again (`PHONE_DISPUTED`), only by its QR, so someone who signed up first with another person's number cannot collect the stamps that person asks for. Refusals (`CARD_NOT_FOUND`, `CARD_REPLACED`, `PHONE_NOT_CONFIRMED`, `PHONE_DISPUTED`, `UNKNOWN_ORDER_TYPE`) are kept in the ledger, so a resend gets the same answer, and appear in the counter's error list. A held visit is applied, by its own time, only when the owner accepts it: one from a removed phone or barista, or one that reached the server more than two days after it happened (its time is the phone's to set and decides the cooldown and the daily cap, so backdated visits never stamp unseen). Accepting one says when it still added no stamps (cooldown, daily cap or a deleted card). The ledger keeps an HMAC of each event (keyed with the pepper), never a plain hash, which the stored visit would let anyone with the database reverse into the phone number.
- **Rewards** are online only: the barista scans the card, and the server takes the program's stamps in one atomic step, recorded once per redemption id. The counter keeps an unconfirmed redemption in IndexedDB and must try it again (same id, so it gets the first answer) before giving another, even after a reload or an update; it shows when that redemption started, so the barista knows which customer it was for. A build past the support window still gets the answer to a redemption it already sent. Offline, the counter says rewards need a connection.
- **Deleting a card** keeps its visits and redemptions for the café's numbers, with no link to the card.

## Customer cards

- **Signup.** The owner prints the café's signup QR (dashboard, Café page), which opens `PUBLIC_URL/join/<code>`. The customer enters a mobile number (Arabic-Indic digits, spaces, dashes, a leading `0` or `00961` are all fine; it is normalised to E.164), accepts the privacy notice and may opt in to offers; both are stored with their time. The reply is a redirect to a new web card, after at least 400 ms, whatever the number's history: a new number gets a linked card; a number known at other cafés gets a linked card here; a number that already has a card here gets a fresh, unlinked card that works by QR only, and the number can no longer stamp the existing card (see Stamping). The existing card is never shown. Signup is limited to 60 attempts per hour per address and, as a backstop, 1,000 cards per hour per café (valid signups only, so junk cannot shut a café's page); the owner can replace a misused code. Deleting a card also takes a minimum time, so it never reveals whether the card was linked.
- **Phone numbers** are stored as an HMAC-SHA256 lookup hash (`PHONE_LOOKUP_PEPPER`) and AES-256-GCM ciphertext (`PHONE_ENCRYPTION_KEYS`). A café reaches a customer only through its own cards. Because numbers are not verified, everything a card holder controls (recovery email, offers, deletion) belongs to the card, not the number.
- **Web card** (`/c/<256-bit secret>`): server-rendered in Arabic or English, with no script, a hash-based Content-Security-Policy, `no-store`, `no-referrer` and `noindex`. It shows the stamps and a QR signed with HMAC-SHA256 over card, café, epoch and key id (`CARD_QR_KEYS`), checked in constant time.
- **Recovery.** A card holder may add an email. `/recover` emails a single-use link (`/r/<token>`, 30 minutes, newest only, same reply whether or not a card uses the email). Opening it shows buttons; restoring gives every card with that email a new epoch and a new link, so old QR codes and links stop working, and deleting removes those cards.
- **Deletion.** Deleting a card (from its page, or all cards of an email from a recovery link) removes it, and the phone number too once no café has a card for it. Deletions are audit-logged without personal data.

## Continuous integration

`.github/workflows/ci.yml` runs `pnpm test` on Ubuntu with the Node version from `.nvmrc`, a frozen lockfile, Playwright Chromium and a PostgreSQL 18 service container (trust authentication, reachable only from the job). It has read-only repository permissions, pins every action to a commit SHA, and uploads the Playwright report when a run fails.

## Configuration

Every setting comes from environment variables; `.env.example` lists all of them, with optional ones commented out at their defaults. Each app validates its environment at start-up and exits with the names of any missing or invalid variables, never their values. `BUILT_AT` (the release's commit time, ISO 8601 UTC) must be the same for the server and the counter build of a release; CI sets it from the commit, and the server requires it in production.
