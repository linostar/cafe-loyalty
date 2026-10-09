import { APPLE_PASS_UPDATE_QUEUE, GOOGLE_PASS_UPDATE_QUEUE, sendInTransaction, type Database, type PassUpdateJob, type PgBoss } from "@cafe-loyalty/db";
import { sql, type Transaction } from "kysely";

/**
 * Queues the update of each of a card's wallet passes this transaction changed (AC 12, 13), inside the same
 * transaction (withCafe for the card's café): a change that rolls back sends nothing, and the stamp itself never waits
 * for APNs or Google. The database marks the passes changed when the card's stamps or epoch change
 * (cards_touch_apple_passes and cards_touch_google_passes, migrations 0008 and 0009); call this after such a change.
 * Without a job queue (it failed to start) the passes are still marked, and Apple devices see the change when Wallet
 * next refreshes them.
 */
export async function queuePassUpdate(trx: Transaction<Database>, jobs: PgBoss | undefined, cafeId: string, cardId: string): Promise<void> {
  if (jobs === undefined) {
    return;
  }
  const changedNow = sql<string>`pg_current_xact_id()`;
  const apple = await trx.selectFrom("apple_passes").select("id").where("card_id", "=", cardId).where("updated_xid", "=", changedNow).execute();
  const google = await trx.selectFrom("google_passes").select("id").where("card_id", "=", cardId).where("updated_xid", "=", changedNow).execute();
  for (const [queue, passes] of [
    [APPLE_PASS_UPDATE_QUEUE, apple],
    [GOOGLE_PASS_UPDATE_QUEUE, google],
  ] as const) {
    for (const pass of passes) {
      await queueOne(trx, jobs, queue, { cafeId, passId: pass.id });
    }
  }
}

/** Queues one pass's update; at most one waits per pass (its id is the singletonKey). */
export async function queueOne(trx: Transaction<Database>, jobs: PgBoss, queue: string, job: PassUpdateJob): Promise<void> {
  await sendInTransaction(jobs, trx, queue, job, { singletonKey: job.passId });
}
