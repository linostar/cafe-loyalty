import { formatStartupFailure } from "@cafe-loyalty/shared";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { createJobQueue, jobQueueTask } from "./jobs.js";
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

const tasks: WorkerTask[] = [jobQueueTask(createJobQueue(config.DATABASE_URL, logger), logger, config.SHUTDOWN_TIMEOUT_MS)];
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
  process.exit(0);
} catch (error) {
  logger.fatal({ err: error }, "worker failed");
  process.exit(1);
}
