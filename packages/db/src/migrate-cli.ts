import { formatStartupFailure } from "@cafe-loyalty/shared";
import pg from "pg";
import { loadMigrateEnv, type MigrateEnv } from "./config.js";
import { createCliLogger } from "./logger.js";
import { migrate, type MigrateOptions } from "./migrate.js";
import { loadMigrations } from "./migrations.js";

let env: MigrateEnv;
try {
  env = loadMigrateEnv(process.env);
} catch (error) {
  process.stderr.write(`${formatStartupFailure(error, "db-migrate")}\n`);
  process.exit(1);
}

const logger = createCliLogger(env.LOG_LEVEL);

/** The running release's commits (its history), one 40-character commit per line on stdin, for expand mode. */
async function deployedCommits(): Promise<ReadonlySet<string>> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.some((line) => !/^[0-9a-f]{40}$/.test(line))) {
    throw new Error("MIGRATE_MODE=expand reads the running release's commits on stdin, one 40-character commit per line; another line was given.");
  }
  return new Set(lines);
}

const client = new pg.Client({ connectionString: env.MIGRATOR_DATABASE_URL, connectionTimeoutMillis: 10_000, application_name: "cafe-loyalty-migrate" });
let exitCode = 0;
try {
  const migrations = await loadMigrations();
  const options: MigrateOptions = env.MIGRATE_MODE === "expand" ? { deployedCommits: await deployedCommits() } : {};
  await client.connect();
  const outcome = await migrate(client, migrations, logger, options);
  logger.info({ applied: outcome.applied, alreadyApplied: outcome.alreadyApplied, mode: env.MIGRATE_MODE }, "migrations complete");
} catch (error) {
  logger.fatal({ err: error }, "migration failed");
  exitCode = 1;
} finally {
  await client.end().catch((error: unknown) => {
    logger.error({ err: error }, "failed to close the database connection");
  });
}
process.exit(exitCode);
