import { formatStartupFailure } from "@cafe-loyalty/shared";
import { bootstrap } from "./bootstrap.js";
import { loadBootstrapEnv, type BootstrapEnv } from "./config.js";
import { createCliLogger } from "./logger.js";

let env: BootstrapEnv;
try {
  env = loadBootstrapEnv(process.env);
} catch (error) {
  process.stderr.write(`${formatStartupFailure(error, "db-bootstrap")}\n`);
  process.exit(1);
}

const logger = createCliLogger(env.LOG_LEVEL);
try {
  await bootstrap(
    {
      adminUrl: env.DATABASE_ADMIN_URL,
      databaseName: env.DATABASE_NAME,
      migratorRole: env.MIGRATOR_ROLE,
      migratorPassword: env.MIGRATOR_PASSWORD,
      appRole: env.APP_ROLE,
      appPassword: env.APP_PASSWORD,
    },
    logger,
  );
} catch (error) {
  logger.fatal({ err: error, database: env.DATABASE_NAME }, "bootstrap failed");
  process.exit(1);
}
