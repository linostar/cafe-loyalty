import { formatStartupFailure } from "@cafe-loyalty/shared";
import pg from "pg";
import { loadMigrateEnv, type MigrateEnv } from "./config.js";
import { createCliLogger } from "./logger.js";
import { migrate } from "./migrate.js";
import { loadMigrations } from "./migrations.js";

let env: MigrateEnv;
try {
  env = loadMigrateEnv(process.env);
} catch (error) {
  process.stderr.write(`${formatStartupFailure(error, "db-migrate")}\n`);
  process.exit(1);
}

const logger = createCliLogger(env.LOG_LEVEL);
const client = new pg.Client({ connectionString: env.MIGRATOR_DATABASE_URL, connectionTimeoutMillis: 10_000, application_name: "cafe-loyalty-migrate" });
let exitCode = 0;
try {
  const migrations = await loadMigrations();
  await client.connect();
  const outcome = await migrate(client, migrations, logger);
  logger.info({ applied: outcome.applied, alreadyApplied: outcome.alreadyApplied }, "migrations complete");
} catch (error) {
  logger.fatal({ err: error }, "migration failed");
  exitCode = 1;
} finally {
  await client.end().catch((error: unknown) => {
    logger.error({ err: error }, "failed to close the database connection");
  });
}
process.exit(exitCode);
