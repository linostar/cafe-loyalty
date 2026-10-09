import { PgBoss } from "pg-boss";
import type { Logger } from "pino";
import type { WorkerTask } from "./worker.js";

/** Removes expired owner sessions, reset links, invites, device tokens, pairing codes and card recovery links. */
export const PURGE_QUEUE = "purge-expired-credentials";
/** Hourly, off the top of the hour. */
const PURGE_CRON = "17 * * * *";
/** How long stopping waits for a running job before giving up on it (it runs again later). */
const STOP_TIMEOUT_MS = 8_000;

/**
 * pg-boss as this app runs it. The schema is the migrator's (packages/db/migrations/0007_job_queue.sql) and the app
 * role may not change it, so everything that would create or alter tables is off; start() refuses a database whose
 * pg-boss schema version differs from this library's.
 */
export function createJobQueue(connectionString: string, logger: Logger, applicationName = "cafe-loyalty-worker"): PgBoss {
  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    application_name: applicationName,
    max: 4,
    migrate: false,
    createSchema: false,
    reindex: false,
    persistQueueStats: false,
    persistWarnings: false,
  });
  boss.on("error", (error) => {
    logger.error({ err: error }, "job queue error");
  });
  return boss;
}

/**
 * Deletes expired credentials in every café. The one job that is not a café's own: the function it calls runs as
 * the owner role and sees only expired rows, so it cannot reach anything else (migration 0007).
 */
export async function purgeExpiredCredentials(boss: PgBoss, logger: Logger): Promise<Record<string, number>> {
  const { rows } = await boss.getDb().executeSql("SELECT table_name, deleted FROM app.purge_expired_credentials()");
  const deleted = Object.fromEntries((rows as { table_name: string; deleted: string }[]).map((row) => [row.table_name, Number(row.deleted)]));
  logger.info({ job: PURGE_QUEUE, deleted }, "expired credentials purged");
  return deleted;
}

/** Runs the job queue: the hourly purge for now. */
export function jobQueueTask(boss: PgBoss, logger: Logger): WorkerTask {
  return {
    name: "job-queue",
    async start() {
      await boss.start();
      await boss.createQueue(PURGE_QUEUE);
      await boss.schedule(PURGE_QUEUE, PURGE_CRON);
      await boss.work(PURGE_QUEUE, async () => {
        await purgeExpiredCredentials(boss, logger);
      });
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
    },
  };
}
