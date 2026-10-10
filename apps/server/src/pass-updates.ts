import { queueChangedPasses, sendInTransaction, type Database, type PassUpdateJob, type PgBoss } from "@cafe-loyalty/db";
import type { Transaction } from "kysely";

/**
 * Queues the update of each of a card's wallet passes this transaction changed (AC 12, 13), inside the same
 * transaction (withCafe for the card's café): a change that rolls back sends nothing, and the stamp itself never waits
 * for APNs or Google. The database marks the passes changed when the card's stamps, epoch or offer opt-in change
 * (cards_touch_apple_passes, cards_touch_google_passes and cards_touch_offer_passes, migrations 0008, 0009 and 0013);
 * call this after such a change.
 * Without a job queue (it failed to start) the passes are still marked, and Apple devices see the change when Wallet
 * next refreshes them.
 */
export async function queuePassUpdate(trx: Transaction<Database>, jobs: PgBoss | undefined, cafeId: string, cardId: string): Promise<void> {
  if (jobs !== undefined) {
    await queueChangedPasses(jobs, trx, cafeId, [cardId]);
  }
}

/** Queues one pass's update; at most one waits per pass (its id is the singletonKey). */
export async function queueOne(trx: Transaction<Database>, jobs: PgBoss, queue: string, job: PassUpdateJob): Promise<void> {
  await sendInTransaction(jobs, trx, queue, job, { singletonKey: job.passId });
}
