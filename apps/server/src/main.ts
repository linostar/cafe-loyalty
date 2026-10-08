import { formatStartupFailure } from "@cafe-loyalty/shared";
import { buildApp } from "./app.js";
import { loadServerConfig, type ServerConfig } from "./config.js";

let config: ServerConfig;
try {
  config = loadServerConfig(process.env);
} catch (error) {
  process.stderr.write(`${formatStartupFailure(error, "server")}\n`);
  process.exit(1);
}

const app = buildApp({ logLevel: config.LOG_LEVEL });

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, "shutdown requested");
  const timer = setTimeout(() => {
    app.log.error({ timeoutMs: config.SHUTDOWN_TIMEOUT_MS }, "shutdown timed out, forcing exit");
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try {
    await app.close();
    app.log.info("server closed");
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal({ err: error }, "server failed to start");
  process.exit(1);
}
