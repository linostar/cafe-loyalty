import { APPLE_PASS_UPDATE_QUEUE, JOB_STATEMENT_TIMEOUT_MS, startJobQueue, type Database, type Job, type PgBoss } from "@cafe-loyalty/db";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { PassPusher } from "./apns.js";
import { pushPassUpdate } from "./apple-passes.js";
import type { WorkerTask } from "./worker.js";

/** Removes expired owner sessions, reset links, invites, device tokens, pairing codes and card recovery links. */
export const PURGE_QUEUE = "purge-expired-credentials";
/** Hourly, off the top of the hour. */
const PURGE_CRON = "17 * * * *";

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

export interface JobDependencies {
  /** The app's database, for the café jobs (withCafe with the café id from the job). */
  db: Kysely<Database>;
  /** APNs, or undefined when Apple Wallet is not configured: pass update jobs then fail, logged. */
  pusher: PassPusher | undefined;
}

/** A job handler whose failures are logged: pg-boss records them and retries, but reports them nowhere else. */
function logged(queue: string, logger: Logger, run: (job: Job) => Promise<object>) {
  return async ([job]: Job[]) => {
    if (job === undefined) {
      return {};
    }
    try {
      // The result becomes the job's output.
      return await run(job);
    } catch (error) {
      logger.error({ err: error, job: queue, jobId: job.id }, "job failed");
      throw error;
    }
  };
}

/**
 * Runs the job queue: the hourly purge and Apple pass updates. Stopping waits for running jobs at most what is left
 * of `shutdownTimeoutMs` after the longest statement (closing the pool waits for that), so the worker stops in time.
 */
export function jobQueueTask(boss: PgBoss, logger: Logger, shutdownTimeoutMs: number, dependencies: JobDependencies): WorkerTask {
  return {
    name: "job-queue",
    async start() {
      await startJobQueue(boss);
      await boss.createQueue(PURGE_QUEUE);
      await boss.schedule(PURGE_QUEUE, PURGE_CRON);
      await boss.work(
        PURGE_QUEUE,
        logged(PURGE_QUEUE, logger, () => purgeExpiredCredentials(boss, logger)),
      );
      await boss.work(
        APPLE_PASS_UPDATE_QUEUE,
        logged(APPLE_PASS_UPDATE_QUEUE, logger, (job) => {
          if (dependencies.pusher === undefined) {
            throw new Error("Apple Wallet is not configured on the worker: set the APPLE_PASS_* variables.");
          }
          return pushPassUpdate(dependencies.db, dependencies.pusher, logger, job.data);
        }),
      );
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: Math.max(0, shutdownTimeoutMs - JOB_STATEMENT_TIMEOUT_MS - 1_000) });
      dependencies.pusher?.close();
    },
  };
}
