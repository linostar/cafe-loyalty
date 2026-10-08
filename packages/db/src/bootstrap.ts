import pg from "pg";
import { APP_GROUP_ROLE, OWNER_GROUP_ROLE, assertRoleOrDatabaseName } from "./roles.js";
import { scramSha256Verifier } from "./scram.js";

export interface BootstrapOptions {
  /** Superuser (or CREATEROLE + CREATEDB) connection to the cluster's maintenance database. */
  adminUrl: string;
  databaseName: string;
  migratorRole: string;
  migratorPassword: string;
  appRole: string;
  appPassword: string;
}

export interface BootstrapLog {
  info(data: Record<string, unknown>, message: string): void;
}

const DUPLICATE_OBJECT = "42710";
const UNIQUE_VIOLATION = "23505";
/** Key for the advisory lock that serialises bootstraps on one cluster (role DDL races otherwise). */
const LOCK_KEY = 74_201_902;

function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === DUPLICATE_OBJECT || code === UNIQUE_VIOLATION;
}

/** The admin URL pointed at another database on the same server. */
export function withDatabase(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

const ROLE_ATTRIBUTES = "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";

/**
 * Creates a role if missing (never with a password, so no plaintext appears in a failed statement the server
 * logs), re-applies its attributes, and sets its password as a SCRAM verifier computed here.
 */
async function ensureRole(client: pg.Client, name: string, login: boolean, password?: string): Promise<void> {
  const identifier = client.escapeIdentifier(name);
  const attributes = `${login ? "LOGIN" : "NOLOGIN"} ${ROLE_ATTRIBUTES}`;
  const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  if (rowCount === 0) {
    try {
      await client.query(`CREATE ROLE ${identifier} ${attributes}`);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
  }
  // Re-applied on every run, so a role created or changed by hand cannot keep extra powers.
  await client.query(`ALTER ROLE ${identifier} ${attributes}`);
  if (password !== undefined) {
    await client.query(`ALTER ROLE ${identifier} PASSWORD ${client.escapeLiteral(scramSha256Verifier(password))}`);
  }
}

/** Each role's direct group memberships must be exactly `expected`; anything else could hand it more privileges. */
async function assertMemberships(client: pg.Client, expected: Readonly<Record<string, readonly string[]>>): Promise<void> {
  const { rows } = await client.query<{ member: string; group: string }>(
    `SELECT r.rolname AS member, g.rolname AS group
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member
       JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolname = ANY($1)`,
    [Object.keys(expected)],
  );
  for (const [role, groups] of Object.entries(expected)) {
    const actual = rows.filter((row) => row.member === role).map((row) => row.group).sort();
    if (actual.join(",") !== [...groups].sort().join(",")) {
      throw new Error(
        `Role ${role} must be a member of ${groups.length === 0 ? "no role" : groups.join(", ")} only, but is a member of ${actual.length === 0 ? "no role" : actual.join(", ")}. Revoke the extra memberships.`,
      );
    }
  }
}

/** Runs `work`, then `release`; a failure in `release` never hides a failure in `work`. */
async function releasing<T>(work: () => Promise<T>, release: () => Promise<unknown>): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
  await release();
  return result;
}

/**
 * Creates (or brings back in line) the roles, database and schemas, idempotently. Group roles: cl_owner owns
 * objects, cl_app holds runtime privileges. The migrator logs in and switches to cl_owner; the app role logs in
 * with cl_app's privileges only. The group roles are cluster-wide, so each environment needs its own cluster.
 */
export async function bootstrap(options: BootstrapOptions, log: BootstrapLog): Promise<void> {
  if (options.migratorRole === options.appRole) {
    throw new Error("MIGRATOR_ROLE and APP_ROLE must be different roles.");
  }

  const admin = new pg.Client({ connectionString: options.adminUrl, connectionTimeoutMillis: 10_000 });
  await admin.connect();
  await releasing(
    async () => {
      const { rows } = await admin.query<{ user: string }>("SELECT current_user AS user");
      const adminRole = rows[0]?.user;
      assertRoleOrDatabaseName(options.databaseName, "DATABASE_NAME", adminRole);
      assertRoleOrDatabaseName(options.migratorRole, "MIGRATOR_ROLE", adminRole);
      assertRoleOrDatabaseName(options.appRole, "APP_ROLE", adminRole);

      await admin.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
      await releasing(
        async () => {
          await ensureRole(admin, OWNER_GROUP_ROLE, false);
          await ensureRole(admin, APP_GROUP_ROLE, false);
          await ensureRole(admin, options.migratorRole, true, options.migratorPassword);
          await ensureRole(admin, options.appRole, true, options.appPassword);
          await admin.query(`GRANT ${OWNER_GROUP_ROLE} TO ${admin.escapeIdentifier(options.migratorRole)}`);
          await admin.query(`GRANT ${APP_GROUP_ROLE} TO ${admin.escapeIdentifier(options.appRole)}`);
          await assertMemberships(admin, {
            [OWNER_GROUP_ROLE]: [],
            [APP_GROUP_ROLE]: [],
            [options.migratorRole]: [OWNER_GROUP_ROLE],
            [options.appRole]: [APP_GROUP_ROLE],
          });

          const database = admin.escapeIdentifier(options.databaseName);
          const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [options.databaseName]);
          if (rowCount === 0) {
            await admin.query(`CREATE DATABASE ${database} OWNER ${OWNER_GROUP_ROLE}`);
            log.info({ database: options.databaseName }, "database created");
          }
          await admin.query(`ALTER DATABASE ${database} OWNER TO ${OWNER_GROUP_ROLE}`);
          await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
          await admin.query(`REVOKE ALL ON DATABASE ${database} FROM ${APP_GROUP_ROLE}`);
          await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${APP_GROUP_ROLE}`);
          await admin.query(`GRANT CONNECT, CREATE ON DATABASE ${database} TO ${OWNER_GROUP_ROLE}`);
        },
        () => admin.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]),
      );
    },
    () => admin.end(),
  );

  const inDatabase = new pg.Client({ connectionString: withDatabase(options.adminUrl, options.databaseName), connectionTimeoutMillis: 10_000 });
  await inDatabase.connect();
  await releasing(
    async () => {
      await inDatabase.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      await inDatabase.query(`CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION ${OWNER_GROUP_ROLE}`);
      await inDatabase.query(`CREATE SCHEMA IF NOT EXISTS meta AUTHORIZATION ${OWNER_GROUP_ROLE}`);
      await inDatabase.query(`ALTER SCHEMA app OWNER TO ${OWNER_GROUP_ROLE}`);
      await inDatabase.query(`ALTER SCHEMA meta OWNER TO ${OWNER_GROUP_ROLE}`);
      await inDatabase.query("REVOKE ALL ON SCHEMA app, meta FROM PUBLIC");
      await inDatabase.query(`GRANT USAGE ON SCHEMA app TO ${APP_GROUP_ROLE}`);
      // Functions created by migrations are not executable by everyone unless a migration grants it.
      await inDatabase.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_GROUP_ROLE} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
    },
    () => inDatabase.end(),
  );
  log.info({ database: options.databaseName, migratorRole: options.migratorRole, appRole: options.appRole }, "database bootstrapped");
}
