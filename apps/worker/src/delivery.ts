import { passUpdateJobSchema, withCafe, type Database, type PassUpdateJob } from "@cafe-loyalty/db";
import { sql, type Kysely } from "kysely";
import type { Logger } from "pino";

/** A failed delivery, with a short code the owner dashboard shows: what went wrong, never personal data. */
export class DeliveryError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "DeliveryError";
    this.code = code;
  }
}

/** Node's system error codes (ECONNREFUSED, ETIMEDOUT): the only codes taken from errors not our own. */
const SYSTEM_CODE = /^E[A-Z0-9_]{1,40}$/;

/**
 * The code stored for a failure, which the owner sees: a DeliveryError's, a Node system error's, "timeout", or
 * "error" for anything else, so no library's text reaches the dashboard.
 */
export function deliveryErrorCode(error: unknown): string {
  const first: unknown = error instanceof AggregateError ? error.errors[0] : error;
  if (first instanceof DeliveryError) {
    return first.code;
  }
  if (first instanceof Error && first.name === "TimeoutError") {
    return "timeout";
  }
  const code = first instanceof Error ? (first as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && SYSTEM_CODE.test(code) ? code : "error";
}

/**
 * Runs a pass update job's delivery and records its outcome on the pass (AC 13): a failure adds one to the pass's
 * failures in a row, with its time and code, for the owner dashboard (and is rethrown, for pg-boss to retry); a
 * success clears them. Both inside withCafe for the job's café, so a job naming another café's pass changes nothing.
 */
export async function trackDelivery<T>(
  db: Kysely<Database>,
  table: "apple_passes" | "google_passes",
  data: unknown,
  log: Logger,
  deliver: (job: PassUpdateJob) => Promise<T>,
): Promise<T> {
  const job = passUpdateJobSchema.parse(data);
  let result: T;
  try {
    result = await deliver(job);
  } catch (error) {
    await withCafe(db, job.cafeId, (trx) =>
      trx
        .updateTable(table)
        .set({ delivery_failures: sql<number>`delivery_failures + 1`, delivery_failed_at: sql<Date>`now()`, delivery_error: deliveryErrorCode(error) })
        .where("id", "=", job.passId)
        .execute(),
    ).catch((recordError: unknown) => {
      log.error({ err: recordError }, "pass delivery failure could not be recorded");
    });
    throw error;
  }
  await withCafe(db, job.cafeId, (trx) =>
    trx
      .updateTable(table)
      .set({ delivery_failures: 0, delivery_failed_at: null, delivery_error: null })
      .where("id", "=", job.passId)
      .where("delivery_failures", ">", 0)
      .execute(),
  );
  return result;
}
