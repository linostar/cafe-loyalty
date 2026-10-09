import type { Transaction } from "kysely";
import { PgBoss, fromKysely, type Queue, type SendOptions } from "pg-boss";
import type { Logger } from "pino";
import { z } from "zod";
import type { Database } from "./schema.js";

/** The longest any job-queue statement may run, the purge included (its tables are small). */
export const JOB_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * Tells the devices registered for an Apple pass to fetch it again (AC 12, 13). Ids only, never personal data; the
 * worker reads the rest inside withCafe for the job's café.
 */
export const APPLE_PASS_UPDATE_QUEUE = "apple-pass-update";
/** Writes a Google pass's loyalty object as it now is (AC 12, 13); the same job data, naming a google_passes row. */
export const GOOGLE_PASS_UPDATE_QUEUE = "google-pass-update";
export const passUpdateJobSchema = z.object({ cafeId: z.uuid(), passId: z.uuid() });
export type PassUpdateJob = z.infer<typeof passUpdateJobSchema>;

/**
 * A pass update queue: at most one waiting job per pass (sent with the pass id as singletonKey), since a job sends
 * the pass as it is when the job runs, so changes made while one waits go out with it.
 */
const PASS_UPDATE_QUEUE: Omit<Queue, "name"> = {
  policy: "short",
  // Backing off from 30 seconds to an hour, for most of a day of APNs or Google trouble before a job fails.
  retryLimit: 12,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 3_600,
  // Each request times out long before this.
  expireInSeconds: 120,
};

/** The queues the server sends to, created by whichever of the server and the worker starts first. */
const SHARED_QUEUES: Readonly<Record<string, Omit<Queue, "name">>> = {
  [APPLE_PASS_UPDATE_QUEUE]: PASS_UPDATE_QUEUE,
  [GOOGLE_PASS_UPDATE_QUEUE]: PASS_UPDATE_QUEUE,
};

export interface JobQueueOptions {
  applicationName: string;
  /** Connections in pg-boss's own pool. */
  maxConnections: number;
  /** The server only sends jobs: no maintenance, no schedules (the worker runs those). */
  sendOnly?: boolean;
}

/**
 * pg-boss as this app runs it. The schema is the migrator's (packages/db/migrations/0007_job_queue.sql) and the app
 * role may not change it, so everything that would create or alter tables is off; start() refuses a database whose
 * pg-boss schema version differs from this library's.
 */
export function createJobQueue(connectionString: string, logger: Pick<Logger, "error" | "warn">, options: JobQueueOptions): PgBoss {
  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    application_name: options.applicationName,
    max: options.maxConnections,
    migrate: false,
    createSchema: false,
    reindex: false,
    persistQueueStats: false,
    persistWarnings: false,
    ...(options.sendOnly === true ? { supervise: false, schedule: false } : {}),
    // Like the app's pool (database.ts): no statement, and no transaction left open, runs unbounded.
    options: `-c statement_timeout=${String(JOB_STATEMENT_TIMEOUT_MS)} -c idle_in_transaction_session_timeout=${String(3 * JOB_STATEMENT_TIMEOUT_MS)}`,
  });
  boss.on("error", (error) => {
    logger.error({ err: error }, "job queue error");
  });
  // Not stored (persistWarnings is off), so logged: a schedule that cannot fire, clock skew, a backlog, a slow query.
  // The message only: a slow query's data carries its SQL and values.
  boss.on("warning", (warning) => {
    logger.warn({ warning: warning.message }, "job queue warning");
  });
  return boss;
}

/** Starts pg-boss and creates the queues the server sends to (a no-op for those that exist). */
export async function startJobQueue(boss: PgBoss): Promise<void> {
  await boss.start();
  for (const [name, options] of Object.entries(SHARED_QUEUES)) {
    await boss.createQueue(name, options);
  }
}

/**
 * Queues a job inside the caller's transaction: it exists only if that transaction commits, so a rolled-back stamp
 * sends nothing. Null when a job with the same singletonKey is already waiting.
 */
export function sendInTransaction(boss: PgBoss, trx: Transaction<Database>, name: string, data: object, options: Omit<SendOptions, "db"> = {}): Promise<string | null> {
  return boss.send(name, data, { ...options, db: fromKysely(trx) });
}

/**
 * Whether start() failed because the database's pg-boss schema is another version than this library's (a later
 * release migrated it, or this one is ahead of the migrations): pg-boss's own error, matched by its message.
 */
export const isJobQueueVersionMismatch = (error: unknown): boolean =>
  error instanceof Error && error.message === "pg-boss database requires migrations";
