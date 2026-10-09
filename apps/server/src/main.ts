import { JOB_STATEMENT_TIMEOUT_MS, createDatabase, createJobQueue, isJobQueueVersionMismatch, startJobQueue } from "@cafe-loyalty/db";
import { formatStartupFailure } from "@cafe-loyalty/shared";
import { apiRoutes } from "./api.js";
import { buildApp } from "./app.js";
import { BackgroundTasks } from "./background.js";
import { loadServerConfig, type ServerConfig } from "./config.js";
import { customerPages } from "./customer-pages.js";
import { createSmtpMailer } from "./mailer.js";
import { passkitRoutes } from "./passkit-routes.js";

let config: ServerConfig;
try {
  config = loadServerConfig(process.env);
} catch (error) {
  process.stderr.write(`${formatStartupFailure(error, "server")}\n`);
  process.exit(1);
}

const app = buildApp({ logLevel: config.LOG_LEVEL, trustProxyHops: config.TRUST_PROXY_HOPS });
const database = createDatabase({
  connectionString: config.DATABASE_URL,
  applicationName: "cafe-loyalty-server",
  maxConnections: config.DATABASE_MAX_CONNECTIONS,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 15_000,
  idleTimeoutMs: 30_000,
  onPoolError: (error) => {
    app.log.error({ err: error }, "database pool error");
  },
});
const mailer = createSmtpMailer({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  auth: config.SMTP_USER === undefined || config.SMTP_PASSWORD === undefined ? undefined : { user: config.SMTP_USER, password: config.SMTP_PASSWORD },
  from: config.EMAIL_FROM,
});
const background = new BackgroundTasks(app.log);
// Send only: stamps queue their pass updates for the worker, inside their own transactions.
const jobs = createJobQueue(config.DATABASE_URL, app.log, { applicationName: "cafe-loyalty-server", maxConnections: 2, sendOnly: true });

const secrets = {
  phoneLookupPepper: Buffer.from(config.PHONE_LOOKUP_PEPPER, "base64"),
  phoneEncryption: { keys: config.PHONE_ENCRYPTION_KEYS },
  cardQr: { keys: config.CARD_QR_KEYS },
};

// pg-boss refuses a database whose pg-boss schema is another version than this release's (a later release upgraded it
// and this one was rolled back). The server then still serves: stamps are recorded and passes marked changed, but no
// pass update is pushed until a matching release runs. Any other failure (no database) stops the server.
let startedJobs: typeof jobs | undefined;
try {
  await startJobQueue(jobs);
  startedJobs = jobs;
} catch (error) {
  if (!isJobQueueVersionMismatch(error)) {
    app.log.fatal({ err: error }, "job queue failed to start");
    process.exit(1);
  }
  app.log.error({ err: error }, "job queue schema is another version than this release's: running without it, so wallet pass updates are not pushed");
  // Releases whatever the failed start opened.
  await jobs.stop({ graceful: false }).catch((stopError: unknown) => {
    app.log.error({ err: stopError }, "job queue failed to stop after its failed start");
  });
}
if (config.applePasses === undefined) {
  app.log.warn("Apple Wallet is off: no APPLE_* variables are set, so web cards offer no Apple pass");
}

await app.register(apiRoutes, {
  prefix: "/api",
  db: database.db,
  mailer,
  background,
  dashboardUrl: config.DASHBOARD_URL,
  counterUrl: config.COUNTER_URL,
  publicUrl: config.PUBLIC_URL,
  releaseBuiltAt: config.BUILT_AT,
  secrets,
  jobs: startedJobs,
});
await app.register(customerPages, {
  db: database.db,
  mailer,
  background,
  publicUrl: config.PUBLIC_URL,
  secrets,
  jobs: startedJobs,
  apple: config.applePasses,
});
if (config.applePasses !== undefined) {
  await app.register(passkitRoutes, { prefix: "/passkit", db: database.db, secrets, apple: config.applePasses, publicUrl: config.PUBLIC_URL });
}
// Runs once the server has stopped taking requests: finish emails in flight, then release connections.
app.addHook("onClose", async () => {
  await background.drain();
  mailer.close();
  await startedJobs?.stop({ graceful: true, timeout: JOB_STATEMENT_TIMEOUT_MS + 1_000 });
  await database.close();
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, "shutdown requested");
  const timer = setTimeout(() => {
    app.log.error({ timeoutMs: config.SHUTDOWN_TIMEOUT_MS, abandonedTasks: background.pendingCount }, "shutdown timed out, forcing exit");
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

// A wrong SMTP setting shows at startup, not at the first password reset. The server still runs without email.
mailer.verify().then(
  () => {
    app.log.info("SMTP connection verified");
  },
  (error: unknown) => {
    app.log.error({ err: error }, "SMTP connection check failed: password reset emails will fail until the SMTP settings are fixed");
  },
);
