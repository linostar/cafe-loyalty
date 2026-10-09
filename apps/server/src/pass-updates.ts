import { APPLE_PASS_UPDATE_QUEUE, sendInTransaction, type Database, type PassUpdateJob, type PgBoss } from "@cafe-loyalty/db";
import { sql, type Transaction } from "kysely";

/**
 * Queues the push for each of a card's Apple passes this transaction changed (AC 12, 13), inside the same transaction
 * (withCafe for the card's café): a change that rolls back sends nothing, and the stamp itself never waits for APNs.
 * The database marks the passes changed when the card's stamps or epoch change (cards_touch_apple_passes, migration
 * 0008); call this after such a change. Without a job queue (it failed to start) the passes are still marked, and
 * devices see the change when Wallet next refreshes them.
 */
export async function queuePassUpdate(trx: Transaction<Database>, jobs: PgBoss | undefined, cafeId: string, cardId: string): Promise<void> {
  if (jobs === undefined) {
    return;
  }
  const changed = await trx
    .selectFrom("apple_passes")
    .select("id")
    .where("card_id", "=", cardId)
    .where("updated_xid", "=", sql<string>`pg_current_xact_id()`)
    .execute();
  for (const pass of changed) {
    const job: PassUpdateJob = { cafeId, passId: pass.id };
    await sendInTransaction(jobs, trx, APPLE_PASS_UPDATE_QUEUE, job, { singletonKey: pass.id });
  }
}
