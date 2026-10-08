import pg from "pg";
import { APP_GROUP_ROLE, OWNER_GROUP_ROLE, assertRoleOrDatabaseName } from "./roles.js";

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

async function ensureRole(client: pg.Client, name: string, attributes: string, password?: string): Promise<void> {
  const passwordClause = password === undefined ? "" : ` PASSWORD ${client.escapeLiteral(password)}`;
  const identifier = client.escapeIdentifier(name);
  try {
    await client.query(`CREATE ROLE ${identifier} ${attributes} ${ROLE_ATTRIBUTES}${passwordClause}`);
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
  }
  // Re-apply the attributes on every run, so a role created by hand cannot keep extra powers.
  await client.query(`ALTER ROLE ${identifier} ${attributes} ${ROLE_ATTRIBUTES}${passwordClause}`);
}

/**
 * Creates (or brings back in line) the roles, database and schemas, idempotently. Group roles: cl_owner owns
 * objects, cl_app holds runtime privileges. The migrator logs in and switches to cl_owner; the app role logs in
 * with cl_app's privileges and must never be a member of cl_owner, whose objects it would then own.
 */
export async function bootstrap(options: BootstrapOptions, log: BootstrapLog): Promise<void> {
  assertRoleOrDatabaseName(options.databaseName, "DATABASE_NAME");
  assertRoleOrDatabaseName(options.migratorRole, "MIGRATOR_ROLE");
  assertRoleOrDatabaseName(options.appRole, "APP_ROLE");
  if (options.migratorRole === options.appRole) {
    throw new Error("MIGRATOR_ROLE and APP_ROLE must be different roles.");
  }

  const admin = new pg.Client({ connectionString: options.adminUrl, connectionTimeoutMillis: 10_000 });
  await admin.connect();
  try {
    await ensureRole(admin, OWNER_GROUP_ROLE, "NOLOGIN");
    await ensureRole(admin, APP_GROUP_ROLE, "NOLOGIN");
    await ensureRole(admin, options.migratorRole, "LOGIN", options.migratorPassword);
    await ensureRole(admin, options.appRole, "LOGIN", options.appPassword);
    await admin.query(`GRANT ${OWNER_GROUP_ROLE} TO ${admin.escapeIdentifier(options.migratorRole)}`);
    await admin.query(`GRANT ${APP_GROUP_ROLE} TO ${admin.escapeIdentifier(options.appRole)}`);

    const { rows: ownerMembership } = await admin.query<{ member: boolean }>(
      "SELECT pg_has_role($1, $2, 'MEMBER') AS member",
      [options.appRole, OWNER_GROUP_ROLE],
    );
    if (ownerMembership[0]?.member === true) {
      throw new Error(`APP_ROLE ${options.appRole} is a member of ${OWNER_GROUP_ROLE}; it would bypass row-level security. Revoke that membership.`);
    }

    const database = admin.escapeIdentifier(options.databaseName);
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [options.databaseName]);
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE ${database} OWNER ${OWNER_GROUP_ROLE}`);
      log.info({ database: options.databaseName }, "database created");
    }
    await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO ${APP_GROUP_ROLE}`);
    await admin.query(`GRANT CONNECT, CREATE ON DATABASE ${database} TO ${OWNER_GROUP_ROLE}`);
  } finally {
    await admin.end();
  }

  const inDatabase = new pg.Client({ connectionString: withDatabase(options.adminUrl, options.databaseName), connectionTimeoutMillis: 10_000 });
  await inDatabase.connect();
  try {
    await inDatabase.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
    await inDatabase.query(`CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION ${OWNER_GROUP_ROLE}`);
    await inDatabase.query(`CREATE SCHEMA IF NOT EXISTS meta AUTHORIZATION ${OWNER_GROUP_ROLE}`);
    await inDatabase.query("REVOKE ALL ON SCHEMA app, meta FROM PUBLIC");
    await inDatabase.query(`GRANT USAGE ON SCHEMA app TO ${APP_GROUP_ROLE}`);
  } finally {
    await inDatabase.end();
  }
  log.info({ database: options.databaseName, migratorRole: options.migratorRole, appRole: options.appRole }, "database bootstrapped");
}
