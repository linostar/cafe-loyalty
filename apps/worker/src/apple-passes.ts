import { withCafe, type Database, type PassUpdateJob } from "@cafe-loyalty/db";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { PassPusher } from "./apns.js";

/**
 * Tells every device registered for an Apple pass to fetch it again (AC 12, 13). It reads them inside withCafe for
 * the job's café, so a job naming another café's pass finds nothing (AC 2). A device APNs reports gone loses its
 * registration; any other failure fails the job for pg-boss to retry, pushing again to every device (one that already
 * has the change gets 304 from the web service).
 */
export async function pushPassUpdate(db: Kysely<Database>, pusher: PassPusher, logger: Logger, job: PassUpdateJob): Promise<{ sent: number; removed: number }> {
  const registrations = await withCafe(db, job.cafeId, (trx) =>
    trx.selectFrom("apple_pass_registrations").select(["device_library_hash", "push_token"]).where("pass_id", "=", job.passId).execute(),
  );
  const results = await Promise.allSettled(registrations.map((registration) => pusher.push(registration.push_token)));
  const gone = registrations.filter((_, index) => {
    const result = results[index];
    return result?.status === "fulfilled" && result.value === "unregistered";
  });
  if (gone.length > 0) {
    await withCafe(db, job.cafeId, async (trx) => {
      for (const registration of gone) {
        // Only if the device has not registered a new token since.
        await trx
          .deleteFrom("apple_pass_registrations")
          .where("pass_id", "=", job.passId)
          .where("device_library_hash", "=", registration.device_library_hash)
          .where("push_token", "=", registration.push_token)
          .execute();
      }
    });
  }
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  const sent = registrations.length - gone.length - failures.length;
  logger.info({ sent, removed: gone.length, failed: failures.length }, "apple pass update pushed");
  if (failures.length > 0) {
    throw new AggregateError(failures, `${String(failures.length)} of ${String(registrations.length)} pass pushes failed.`);
  }
  return { sent, removed: gone.length };
}
