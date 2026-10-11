import type { ClientBase } from "pg";
import type { MigrationFile } from "./migrations.js";
import { OWNER_GROUP_ROLE } from "./roles.js";

export interface MigrationLog {
  info(data: Record<string, unknown>, message: string): void;
}

export interface MigrateOptions {
  /**
   * Expand-only mode, for deploys: the commits of the release running now (its history, itself included). A pending
   * contract migration is then applied only when that release is at or after its requires-deployed commit, and
   * otherwise the run refuses before applying anything. Unset, every pending migration is applied (development, tests,
   * an environment's first deploy).
   */
  deployedCommits?: ReadonlySet<string>;
}

export interface MigrationOutcome {
  applied: string[];
  alreadyApplied: number;
}

export class MigrationStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationStateError";
  }
}

/** Key for the session advisory lock that stops two migration runs overlapping. */
const LOCK_KEY = 74_201_901;

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
}

/**
 * Applies pending migrations in order, one transaction each, as the owner role. Refuses to run when the
 * database's history does not match the files: an applied migration was edited, or the database has migrations
 * this release does not know (it is newer than this release; roll forward instead). With `deployedCommits`, also
 * refuses a pending contract migration the running release is not yet at or after (AC 47).
 * `client` must be connected as a login role that is a member of the owner role.
 */
export async function migrate(client: ClientBase, migrations: readonly MigrationFile[], log: MigrationLog, options: MigrateOptions = {}): Promise<MigrationOutcome> {
  await client.query(`SET ROLE ${OWNER_GROUP_ROLE}`);
  await client.query("SET search_path = app");
  await client.query("SET idle_in_transaction_session_timeout = '1min'");
  await client.query("SET lock_timeout = '10s'");
  await client.query("SET statement_timeout = '5min'");
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS meta.schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    // The release a contract migration requires, so a rollback can refuse a release from before it (deploy/rollback.sh).
    await client.query("ALTER TABLE meta.schema_migrations ADD COLUMN IF NOT EXISTS requires_deployed text");
    const { rows } = await client.query<AppliedRow>("SELECT version, name, checksum FROM meta.schema_migrations ORDER BY version");
    verifyHistory(rows, migrations);

    const pending = migrations.slice(rows.length);
    if (options.deployedCommits !== undefined) {
      verifyContractGate(pending, options.deployedCommits);
    }
    const applied: string[] = [];
    for (const migration of pending) {
      await client.query("BEGIN");
      try {
        // Re-set inside every transaction, so nothing a previous migration did can change who owns new objects.
        await client.query(`SET LOCAL ROLE ${OWNER_GROUP_ROLE}`);
        await client.query("SET LOCAL search_path = app");
        await client.query(migration.sql);
        await client.query("INSERT INTO meta.schema_migrations (version, name, checksum, requires_deployed) VALUES ($1, $2, $3, $4)", [
          migration.version,
          migration.name,
          migration.checksum,
          migration.requiresDeployed,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        // A failed ROLLBACK (for example a lost connection) must not hide why the migration failed.
        await client.query("ROLLBACK").catch(() => undefined);
        throw new MigrationStateError(`Migration ${migration.fileName} failed and was rolled back: ${(error as Error).message}`, {
          cause: error,
        });
      }
      applied.push(migration.version);
      log.info({ version: migration.version, name: migration.name, kind: migration.kind }, "migration applied");
    }
    const outcome = { applied, alreadyApplied: rows.length };
    await release(client);
    return outcome;
  } catch (error) {
    await release(client).catch(() => undefined);
    throw error;
  }
}

async function release(client: ClientBase): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  await client.query("RESET ROLE");
}

/** Refuses the whole run, so a deploy changes nothing, when a pending contract migration would break the running release. */
function verifyContractGate(pending: readonly MigrationFile[], deployedCommits: ReadonlySet<string>): void {
  const blocked = pending.filter((migration) => migration.kind === "contract" && !deployedCommits.has(migration.requiresDeployed ?? ""));
  if (blocked.length > 0) {
    throw new MigrationStateError(
      `Contract migration ${blocked.map((migration) => `${migration.fileName} (requires-deployed ${migration.requiresDeployed ?? "(missing)"})`).join(", ")} would break the running release, which is not at or after that commit. Deploy a release at or after it first; nothing was migrated.`,
    );
  }
}

function verifyHistory(applied: readonly AppliedRow[], migrations: readonly MigrationFile[]): void {
  applied.forEach((row, index) => {
    const file = migrations[index];
    if (file === undefined) {
      throw new MigrationStateError(
        `The database has migration ${row.version}_${row.name}, which this release does not include. It was migrated by a newer release; deploy that release or a later one.`,
      );
    }
    if (file.version !== row.version) {
      throw new MigrationStateError(`Migration history is out of order: database has ${row.version} where this release has ${file.version}.`);
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationStateError(`Migration ${file.fileName} was edited after it was applied. Restore the original file and add a new migration instead.`);
    }
  });
}
