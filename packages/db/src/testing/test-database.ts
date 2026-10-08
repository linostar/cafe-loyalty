import { randomBytes } from "node:crypto";
import pg from "pg";
import { bootstrap, withDatabase } from "../bootstrap.js";
import { createDatabase, type DatabaseHandle } from "../database.js";
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
  const app = createDatabase({
    connectionString: appUrl,
    applicationName: "cafe-loyalty-test",
    maxConnections: 4,
    connectionTimeoutMs: 10_000,
    statementTimeoutMs: 10_000,
    idleInTransactionTimeoutMs: 10_000,
    idleTimeoutMs: 1_000,
    onPoolError: (error) => poolErrors.push(error),
  });

  return {
    name,
    adminUrl: withDatabase(adminUrl, name),
    migratorUrl,
    appUrl,
    appRole,
    app,
    async cleanup() {
      await app.close();
      await dropTestObjects(adminUrl, name, [migratorRole, appRole]);
      if (poolErrors.length > 0) {
        throw new AggregateError(poolErrors, "The app connection pool reported errors during the test.");
      }
    },
  };
}
