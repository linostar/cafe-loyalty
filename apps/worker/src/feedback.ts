import { queueChangedPasses, withCafe, type Database, type PgBoss } from "@cafe-loyalty/db";
import { sql, type Kysely } from "kysely";
import type { Logger } from "pino";

/** Gives cards a feedback request for their latest visit. */
export const FEEDBACK_QUEUE = "request-visit-feedback";
/** Every 15 minutes, off the other jobs' minutes: a visit is asked about 2 to 2¼ hours after it. */
export const FEEDBACK_CRON = "9,24,39,54 * * * *";
/** A visit is asked about this long after it (AC 37)… */
export const FEEDBACK_DELAY_HOURS = 2;
/** …and not once it is older than this (a counter that synced a day late): the customer has moved on. */
export const FEEDBACK_MAX_AGE_HOURS = 24;
/** A card is asked at most once in this many hours, however often it visits. */
export const FEEDBACK_CARD_INTERVAL_HOURS = 24;
/** Requests given per café per run. ponytail: a fixed batch; the next run, 15 minutes on, takes the rest. */
export const FEEDBACK_BATCH = 500;

/**
 * The feedback job (AC 37), for each café (from a function that runs as the owner role and returns ids only, migration
 * 0015), each in its own withCafe transaction, so one failing leaves the others done: each card's latest member visit
 * (held, discarded and card-gone ones aside) gets a feedback request once it is FEEDBACK_DELAY_HOURS old, until it is
 * FEEDBACK_MAX_AGE_HOURS old, unless the card got one in the last FEEDBACK_CARD_INTERVAL_HOURS. A request puts its
 * link on the card's passes (the insert trigger marks them; their updates are queued in the same transaction),
 * silently: AC 14's one notifying update a day is kept for offers.
 */
export async function requestFeedback(boss: PgBoss, db: Kysely<Database>, logger: Logger): Promise<{ cafes: number; requested: number }> {
  const { rows } = await boss.getDb().executeSql("SELECT cafe_id FROM app.cafes_for_feedback()");
  const totals = { cafes: rows.length, requested: 0 };
  const failures: unknown[] = [];
  for (const { cafe_id: cafeId } of rows as { cafe_id: string }[]) {
    try {
      const requested = await withCafe(db, cafeId, async (trx) => {
        const { rows: created } = await sql<{ card_id: string }>`
          INSERT INTO feedback_requests (cafe_id, card_id, visit_id)
          SELECT latest.cafe_id, latest.card_id, latest.id
            FROM (
              SELECT DISTINCT ON (visits.card_id) visits.cafe_id, visits.card_id, visits.id, visits.occurred_at
                FROM visits
               WHERE visits.card_id IS NOT NULL
                 AND visits.outcome NOT IN ('held', 'discarded', 'card_gone')
                 AND visits.occurred_at > now() - ${FEEDBACK_MAX_AGE_HOURS}::int * interval '1 hour'
               ORDER BY visits.card_id, visits.occurred_at DESC, visits.id DESC
            ) AS latest
           -- The card's latest visit, not its latest one old enough: a newer visit waits its turn instead.
           WHERE latest.occurred_at <= now() - ${FEEDBACK_DELAY_HOURS}::int * interval '1 hour'
             AND NOT EXISTS (
               SELECT 1 FROM feedback_requests
                WHERE feedback_requests.card_id = latest.card_id
                  AND feedback_requests.created_at > now() - ${FEEDBACK_CARD_INTERVAL_HOURS}::int * interval '1 hour'
             )
           ORDER BY latest.occurred_at, latest.id
           LIMIT ${FEEDBACK_BATCH}::int
          ON CONFLICT (visit_id) DO NOTHING
          RETURNING card_id`.execute(trx);
        const cards = created.map((row) => row.card_id);
        await queueChangedPasses(boss, trx, cafeId, cards);
        return cards.length;
      });
      logger.info({ cafeId, requested }, "feedback requested");
      totals.requested += requested;
    } catch (error) {
      logger.error({ err: error, cafeId }, "feedback run failed");
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${String(failures.length)} cafés' feedback runs failed.`);
  }
  return totals;
}
