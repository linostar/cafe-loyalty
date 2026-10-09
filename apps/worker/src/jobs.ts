import { APPLE_PASS_UPDATE_QUEUE, GOOGLE_PASS_UPDATE_QUEUE, JOB_STATEMENT_TIMEOUT_MS, startJobQueue, type Database, type Job, type PgBoss } from "@cafe-loyalty/db";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { PassPusher } from "./apns.js";
import { pushPassUpdate } from "./apple-passes.js";
import { trackDelivery } from "./delivery.js";
import { writeGooglePass, type GooglePassSettings } from "./google-passes.js";
import type { GoogleWallet } from "./google-wallet.js";
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
  logger.info({ deleted }, "expired credentials purged");
  return deleted;
}

export interface JobDependencies {
  /** The app's database, for the café jobs (withCafe with the café id from the job). */
  db: Kysely<Database>;
  /** APNs, or undefined when Apple Wallet is not configured: this worker then leaves pass updates queued. */
  pusher: PassPusher | undefined;
  /** Google Wallet and what building its objects takes, or undefined (Google pass updates then stay queued). */
  google: { wallet: GoogleWallet; settings: GooglePassSettings } | undefined;
}

/**
 * A job handler that logs under the job's queue, id and café (when its data names one), and logs its failure:
 * pg-boss records failures and retries, but reports them nowhere else.
 */
function logged(queue: string, logger: Logger, run: (job: Job, log: Logger) => Promise<object>) {
  return async ([job]: Job[]) => {
    if (job === undefined) {
      return {};
    }
    const cafeId = (job.data as { cafeId?: unknown } | null)?.cafeId;
    const log = logger.child({ job: queue, jobId: job.id, ...(typeof cafeId === "string" ? { cafeId } : {}) });
    try {
      // The result becomes the job's output.
      return await run(job, log);
    } catch (error) {
      log.error({ err: error }, "job failed");
      throw error;
    }
  };
}

/**
 * Runs the job queue: the hourly purge and, with APNs and Google Wallet, each one's pass updates (without them, those
 * wait, queued, for a worker that has them), recording each update's outcome on its pass (trackDelivery). Stopping waits for running jobs at most what is left of `shutdownTimeoutMs` after the longest
 * statement on each of the two pools (pg-boss's and the app's, both closed after it), so the worker stops in time.
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
        logged(PURGE_QUEUE, logger, (_job, log) => purgeExpiredCredentials(boss, log)),
      );
      const { db, pusher, google } = dependencies;
      if (pusher !== undefined) {
        await boss.work(
          APPLE_PASS_UPDATE_QUEUE,
          logged(APPLE_PASS_UPDATE_QUEUE, logger, (job, log) => trackDelivery(db, "apple_passes", job.data, log, (pass) => pushPassUpdate(db, pusher, log, pass))),
        );
      }
      if (google !== undefined) {
        await boss.work(
          GOOGLE_PASS_UPDATE_QUEUE,
          logged(GOOGLE_PASS_UPDATE_QUEUE, logger, (job, log) =>
            trackDelivery(db, "google_passes", job.data, log, (pass) => writeGooglePass(db, google.wallet, google.settings, log, pass)),
          ),
        );
      }
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: Math.max(0, shutdownTimeoutMs - 2 * JOB_STATEMENT_TIMEOUT_MS - 1_000) });
      dependencies.pusher?.close();
    },
  };
}
