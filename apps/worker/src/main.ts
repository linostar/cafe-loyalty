import { createDatabase, createJobQueue } from "@cafe-loyalty/db";
import { formatStartupFailure } from "@cafe-loyalty/shared";
import { createApnsPusher } from "./apns.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { jobQueueTask } from "./jobs.js";
import { createLogger } from "./logger.js";
import { runWorker, type WorkerTask } from "./worker.js";

let config: WorkerConfig;
try {
  config = loadWorkerConfig(process.env);
} catch (error) {
  process.stderr.write(`${formatStartupFailure(error, "worker")}\n`);
  process.exit(1);
}
const logger = createLogger(config.LOG_LEVEL);
if (config.applePasses === undefined) {
  logger.warn("Apple Wallet is off: no APPLE_PASS_* variables are set, so Apple pass update jobs will fail");
}

const database = createDatabase({
  connectionString: config.DATABASE_URL,
  applicationName: "cafe-loyalty-worker",
  maxConnections: 4,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 15_000,
  idleTimeoutMs: 30_000,
  onPoolError: (error) => {
    logger.error({ err: error }, "database pool error");
  },
});
const tasks: WorkerTask[] = [
  jobQueueTask(createJobQueue(config.DATABASE_URL, logger, { applicationName: "cafe-loyalty-worker", maxConnections: 4 }), logger, config.SHUTDOWN_TIMEOUT_MS, {
    db: database.db,
    pusher: config.applePasses === undefined ? undefined : createApnsPusher(config.applePasses),
  }),
];
const controller = new AbortController();

function requestStop(signal: NodeJS.Signals): void {
  if (controller.signal.aborted) {
    return;
  }
  logger.info({ signal }, "shutdown requested");
  const timer = setTimeout(() => {
    logger.error({ timeoutMs: config.SHUTDOWN_TIMEOUT_MS }, "shutdown timed out, forcing exit");
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  controller.abort();
}

process.on("SIGTERM", requestStop);
process.on("SIGINT", requestStop);

try {
  await runWorker(tasks, logger, controller.signal);
  await database.close();
  process.exit(0);
} catch (error) {
  logger.fatal({ err: error }, "worker failed");
  process.exit(1);
}
