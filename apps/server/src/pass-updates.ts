import { APPLE_PASS_UPDATE_QUEUE, sendInTransaction, type Database, type PassUpdateJob, type PgBoss } from "@cafe-loyalty/db";
import { sql, type Transaction } from "kysely";

/**
 * Marks a card's Apple passes changed and queues the push that tells their devices (AC 12, 13), inside the caller's
 * transaction (withCafe for the card's café): a change that rolls back sends nothing, one that commits always has its
 * job, and the stamp itself never waits for APNs. Call it wherever a card's stamps or epoch change.
 */
export async function queuePassUpdate(trx: Transaction<Database>, jobs: PgBoss, cafeId: string, cardId: string): Promise<void> {
  const changed = await trx
    .updateTable("apple_passes")
    .set({
      updated_xid: sql<string>`pg_current_xact_id()`,
      // Whole seconds, at least one later than before: each change gets a Last-Modified of its own.
      modified_at: sql<Date>`greatest(date_trunc('second', now()), modified_at + interval '1 second')`,
    })
    .where("card_id", "=", cardId)
    .returning("id")
    .execute();
  if (changed.length > 0) {
    const job: PassUpdateJob = { cafeId, cardId };
    await sendInTransaction(jobs, trx, APPLE_PASS_UPDATE_QUEUE, job, { singletonKey: cardId });
  }
}
