import { WIN_BACK_OFFER_DAYS } from "@cafe-loyalty/shared";
import { queueChangedPasses, withCafe, type Database, type PgBoss } from "@cafe-loyalty/db";
import { sql, type Kysely } from "kysely";
import type { Logger } from "pino";

/** Records lapsed cards and gives them the café's win-back offer. */
export const WIN_BACK_QUEUE = "win-back-lapsed-cards";
/** Hourly, off the other jobs' minutes. */
export const WIN_BACK_CRON = "41 * * * *";
/** Offers go out between these hours of the café's day, [from, to), never at night. */
export const WIN_BACK_FROM_HOUR = 10;
export const WIN_BACK_TO_HOUR = 20;
/** A card lapses after at least this many member visits (AC 36)… */
export const LAPSE_MIN_VISITS = 3;
/** …once the time since its last one exceeds twice its median gap between visits, and at least this many days. */
export const LAPSE_MIN_DAYS = 14;
/** Lapses recorded per café per run. ponytail: a fixed batch; the next run, an hour on, takes the rest. */
export const WIN_BACK_BATCH = 500;

/**
 * The win-back job (AC 36), for each café (from a function that runs as the owner role and returns ids only, migration
 * 0014), inside withCafe holding the café's row like the campaign announcer, so the two share AC 14's daily cap without
 * racing:
 * - closes the offers that expired, which leave the cards' passes, at any hour;
 * and, only while the café's local time is within its delivery hours:
 * - records each card that lapsed (at least LAPSE_MIN_VISITS member visits, and the time since the last one longer
 *   than twice the card's median gap or LAPSE_MIN_DAYS days), once per card and last visit;
 * - gives a lapsed card the café's win-back offer, its terms and margin as they are now, for WIN_BACK_OFFER_DAYS, when
 *   the café has one, the card is opted in to offers (AC 4) and was given none within the café's cool-down. A card told
 *   of an offer today (a campaign or win-back) is left for a later run, so it gets at most one notifying update a day.
 * The passes of the cards whose offer came or went are queued in the same transaction (triggers mark them).
 */
export async function runWinBack(boss: PgBoss, db: Kysely<Database>, logger: Logger): Promise<{ cafes: number; lapsed: number; offered: number; expired: number }> {
  const { rows } = await boss.getDb().executeSql("SELECT cafe_id, in_hours FROM app.cafes_for_win_back($1, $2)", [WIN_BACK_FROM_HOUR, WIN_BACK_TO_HOUR]);
  const totals = { cafes: rows.length, lapsed: 0, offered: 0, expired: 0 };
  const failures: unknown[] = [];
  for (const { cafe_id: cafeId, in_hours: inHours } of rows as { cafe_id: string; in_hours: boolean }[]) {
    // One café's failure leaves the others done; the job fails afterwards, for pg-boss to retry.
    try {
      const done = await withCafe(db, cafeId, async (trx) => {
        await trx.selectFrom("cafes").select("id").where("id", "=", cafeId).forNoKeyUpdate().executeTakeFirstOrThrow();
        const expired = await trx
          .updateTable("card_lapses")
          .set({ closed_at: sql<Date>`now()` })
          .where("discount_kind", "is not", null)
          .where("closed_at", "is", null)
          .where("expires_at", "<=", sql<Date>`now()`)
          .returning("card_id")
          .execute();
        if (!inHours) {
          await queueChangedPasses(
            boss,
            trx,
            cafeId,
            expired.map((row) => row.card_id),
          );
          return { lapsed: 0, offered: 0, expired: expired.length };
        }
        const { rows: lapsed } = await sql<{ card_id: string; offered: boolean }>`
          WITH member AS (
            SELECT card_id, occurred_at, occurred_at - lag(occurred_at) OVER (PARTITION BY card_id ORDER BY occurred_at) AS gap
              FROM visits
             WHERE card_id IS NOT NULL AND outcome NOT IN ('held', 'discarded')
          ), per_card AS (
            SELECT card_id, count(*) AS visits, max(occurred_at) AS last_visit_at,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM gap)) AS median_gap_seconds
              FROM member
             GROUP BY card_id
          ), decided AS (
            SELECT per_card.card_id, per_card.last_visit_at,
                   cafes.win_back_discount_kind IS NOT NULL
                     AND cards.offers_opt_in_at IS NOT NULL
                     AND NOT EXISTS (
                       SELECT 1 FROM card_lapses AS earlier
                        WHERE earlier.card_id = per_card.card_id AND earlier.discount_kind IS NOT NULL
                          AND earlier.created_at > now() - cafes.win_back_cooldown_days * interval '1 day'
                     ) AS offer,
                   EXISTS (
                     SELECT 1 FROM campaign_announcements
                      WHERE campaign_announcements.card_id = per_card.card_id
                        AND campaign_announcements.announced_at >= date_trunc('day', now() AT TIME ZONE cafes.time_zone) AT TIME ZONE cafes.time_zone
                   ) OR EXISTS (
                     SELECT 1 FROM card_lapses AS today
                      WHERE today.card_id = per_card.card_id AND today.discount_kind IS NOT NULL
                        AND today.created_at >= date_trunc('day', now() AT TIME ZONE cafes.time_zone) AT TIME ZONE cafes.time_zone
                   ) AS told_today
              FROM per_card
              JOIN cards ON cards.id = per_card.card_id
              JOIN cafes ON cafes.id = cards.cafe_id
             WHERE per_card.visits >= ${LAPSE_MIN_VISITS}::int
               AND now() - per_card.last_visit_at > greatest(2 * coalesce(per_card.median_gap_seconds, 0) * interval '1 second', ${LAPSE_MIN_DAYS}::int * interval '1 day')
               AND NOT EXISTS (SELECT 1 FROM card_lapses WHERE card_lapses.card_id = per_card.card_id AND card_lapses.last_visit_at = per_card.last_visit_at)
          )
          INSERT INTO card_lapses (cafe_id, card_id, last_visit_at, discount_kind, discount_value, min_margin_percent, expires_at)
          SELECT cafes.id, decided.card_id, decided.last_visit_at,
                 CASE WHEN decided.offer THEN cafes.win_back_discount_kind END,
                 CASE WHEN decided.offer THEN cafes.win_back_discount_value END,
                 CASE WHEN decided.offer THEN cafes.min_margin_percent END,
                 CASE WHEN decided.offer THEN now() + ${WIN_BACK_OFFER_DAYS}::int * interval '1 day' END
            FROM decided
            JOIN cafes ON cafes.id = ${cafeId}::uuid
           -- Told of an offer today: given this one on a later run.
           WHERE NOT (decided.offer AND decided.told_today)
           ORDER BY decided.card_id
           LIMIT ${WIN_BACK_BATCH}::int
          RETURNING card_id, discount_kind IS NOT NULL AS offered`.execute(trx);
        const offered = lapsed.filter((row) => row.offered);
        await queueChangedPasses(boss, trx, cafeId, [...expired, ...offered].map((row) => row.card_id));
        return { lapsed: lapsed.length, offered: offered.length, expired: expired.length };
      });
      logger.info({ cafeId, ...done }, "win-back run");
      totals.lapsed += done.lapsed;
      totals.offered += done.offered;
      totals.expired += done.expired;
    } catch (error) {
      logger.error({ err: error, cafeId }, "win-back run failed");
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${String(failures.length)} of ${String(rows.length)} cafés' win-back runs failed.`);
  }
  return totals;
}
