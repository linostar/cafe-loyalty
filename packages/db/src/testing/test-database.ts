import { randomBytes } from "node:crypto";
import pg from "pg";
import { bootstrap, withDatabase } from "../bootstrap.js";
import { createDatabase, withOperatorAccount, type DatabaseHandle } from "../database.js";
import { migrate } from "../migrate.js";
import { loadMigrations } from "../migrations.js";

export interface TestDatabase {
  name: string;
  /** Superuser connection to this test database (for assertions that need the catalog or bypass RLS). */
  adminUrl: string;
  migratorUrl: string;
  appUrl: string;
  appRole: string;
  /** Pool connected as the app login role, the same way the server and worker connect. */
  app: DatabaseHandle;
  /** Pool connected as the migrator login role, the way create-operator connects. */
  migrator: DatabaseHandle;
  cleanup(): Promise<void>;
}

const quiet = { info: () => undefined };

function requireAdminUrl(): string {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL is not set. Start PostgreSQL with `pnpm db:up` and set it in .env (see .env.example).",
    );
  }
  return url;
}

function urlFor(adminUrl: string, role: string, password: string, database: string): string {
  const url = new URL(withDatabase(adminUrl, database));
  url.username = role;
  url.password = password;
  return url.toString();
}

async function dropTestObjects(adminUrl: string, database: string, roles: readonly string[]): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`);
    for (const role of roles) {
      await admin.query(`DROP ROLE IF EXISTS ${admin.escapeIdentifier(role)}`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Creates a fresh database with its own migrator and app login roles, and (unless `migrate: false`) applies the
 * repository's migrations. Each call is isolated, so test files can run in parallel. Call `cleanup` afterwards.
 */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const adminUrl = requireAdminUrl();
  const suffix = randomBytes(6).toString("hex");
  const name = `cl_test_${suffix}`;
  const migratorRole = `cl_test_mig_${suffix}`;
  const appRole = `cl_test_app_${suffix}`;
  const migratorPassword = randomBytes(24).toString("hex");
  const appPassword = randomBytes(24).toString("hex");

  const migratorUrl = urlFor(adminUrl, migratorRole, migratorPassword, name);
  const appUrl = urlFor(adminUrl, appRole, appPassword, name);

  try {
    await bootstrap({ adminUrl, databaseName: name, migratorRole, migratorPassword, appRole, appPassword }, quiet);
    if (options.migrate !== false) {
      const client = new pg.Client({ connectionString: migratorUrl, connectionTimeoutMillis: 10_000 });
      await client.connect();
      try {
        await migrate(client, await loadMigrations(), quiet);
      } finally {
        await client.end();
      }
    }
  } catch (error) {
    await dropTestObjects(adminUrl, name, [migratorRole, appRole]).catch(() => undefined);
    throw error;
  }

  const poolErrors: Error[] = [];
  const pool = (connectionString: string, maxConnections: number) =>
    createDatabase({
      connectionString,
      applicationName: "cafe-loyalty-test",
      maxConnections,
      connectionTimeoutMs: 10_000,
      statementTimeoutMs: 10_000,
      idleInTransactionTimeoutMs: 10_000,
      idleTimeoutMs: 1_000,
      onPoolError: (error) => poolErrors.push(error),
    });
  const app = pool(appUrl, 4);
  const migrator = pool(migratorUrl, 1);

  return {
    name,
    adminUrl: withDatabase(adminUrl, name),
    migratorUrl,
    appUrl,
    appRole,
    app,
    migrator,
    async cleanup() {
      await app.close();
      await migrator.close();
      await dropTestObjects(adminUrl, name, [migratorRole, appRole]);
      if (poolErrors.length > 0) {
        throw new AggregateError(poolErrors, "The app connection pool reported errors during the test.");
      }
    },
  };
}

/** Creates an operator as create-operator does, as the owner role (the app role cannot, migration 0022); keeps an existing one. */
export async function insertOperator(testDb: TestDatabase, values: { id?: string; email: string; password_hash: string }): Promise<string> {
  return withOperatorAccount(testDb.migrator.db, values.email, async (trx) => {
    await trx.insertInto("operators").values(values).onConflict((conflict) => conflict.column("email").doNothing()).execute();
    return (await trx.selectFrom("operators").select("id").where("email", "=", values.email).executeTakeFirstOrThrow()).id;
  });
}
