import { WIN_BACK_OFFER_DAYS } from "@cafe-loyalty/shared";
import { queueChangedPasses, withCafe, type Database, type PgBoss } from "@cafe-loyalty/db";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Logger } from "pino";

/** Records lapsed cards and gives them the café's win-back offer. */
export const WIN_BACK_QUEUE = "win-back-lapsed-cards";
/** Hourly, off the other jobs' minutes. */
export const WIN_BACK_CRON = "41 * * * *";
/** Offers go out between these hours of the café's day, [from, to), never at night. */
export const WIN_BACK_FROM_HOUR = 10;
export const WIN_BACK_TO_HOUR = 20;
/** A card lapses after member visits on at least this many days (AC 36)… */
export const LAPSE_MIN_VISITS = 3;
/** …once the time since its last one exceeds twice its median gap between those days, and at least this many days. */
export const LAPSE_MIN_DAYS = 14;
/** Lapses recorded, and offers given, per café per run. ponytail: a fixed batch; the next run, an hour on, takes the rest. */
export const WIN_BACK_BATCH = 500;

/**
 * The win-back job (AC 36), for each café (from a function that runs as the owner role and returns ids only, migration
 * 0014), each part in its own withCafe transaction, so one failing leaves the others done:
 * - closes the offers that expired, which leave the cards' passes, at any hour;
 * and, only while the café's local time is within its delivery hours:
 * - records each card that lapsed, once per card and last visit: member visits (held and discarded ones aside) on at
 *   least LAPSE_MIN_VISITS days, and the time since the last one longer than twice the median gap between those days
 *   and at least LAPSE_MIN_DAYS days. Each card's last visit is read from the café's whole history, but only cards
 *   last seen more than LAPSE_MIN_DAYS ago and not yet recorded have their visit days measured. ponytail: a full
 *   read of the café's visits each run; a per-card last-visit column if cafés outgrow the job's statement timeout;
 * - gives the café's win-back offer, its terms and margin as they are now, for WIN_BACK_OFFER_DAYS, to each card still
 *   lapsed (no member visit since) that has none yet, once the café has one, the card is opted in to offers (AC 4) and
 *   it got none within the café's cool-down, so a lapse recorded before any of that becomes true still gets it later.
 *   This part holds the café's row like the campaign announcer, so the two share AC 14's daily cap without racing: a
 *   card told of a campaign today is given the offer on a later run.
 * The passes of the cards whose offer came or went are queued in the same transactions (triggers mark them).
 */
export async function runWinBack(boss: PgBoss, db: Kysely<Database>, logger: Logger): Promise<{ cafes: number; lapsed: number; offered: number; expired: number }> {
  const { rows } = await boss.getDb().executeSql("SELECT cafe_id, in_hours FROM app.cafes_for_win_back($1, $2)", [WIN_BACK_FROM_HOUR, WIN_BACK_TO_HOUR]);
  const totals = { cafes: rows.length, lapsed: 0, offered: 0, expired: 0 };
  const failures: unknown[] = [];
  for (const { cafe_id: cafeId, in_hours: inHours } of rows as { cafe_id: string; in_hours: boolean }[]) {
    const done = { lapsed: 0, offered: 0, expired: 0 };
    /** One part in its own transaction, queueing the passes of the cards it changed; a failure leaves the others done. */
    const part = async (name: keyof typeof done, work: (trx: Transaction<Database>) => Promise<{ count: number; changed: string[] }>) => {
      try {
        done[name] = await withCafe(db, cafeId, async (trx) => {
          const { count, changed } = await work(trx);
          await queueChangedPasses(boss, trx, cafeId, changed);
          return count;
        });
      } catch (error) {
        logger.error({ err: error, cafeId, part: name }, "win-back run failed");
        failures.push(error);
      }
    };
    await part("expired", async (trx) => {
      const closed = await trx
        .updateTable("card_lapses")
        .set({ closed_at: sql<Date>`now()` })
        .where("offered_at", "is not", null)
        .where("closed_at", "is", null)
        .where("expires_at", "<=", sql<Date>`now()`)
        .returning("card_id")
        .execute();
      return { count: closed.length, changed: closed.map((row) => row.card_id) };
    });
    if (inHours) {
      // Recorded without an offer, so no pass changes; the next part gives the offers.
      await part("lapsed", async (trx) => ({ count: await recordLapses(trx, cafeId), changed: [] }));
      await part("offered", async (trx) => {
        const offered = await giveOffers(trx, cafeId);
        return { count: offered.length, changed: offered };
      });
    }
    logger.info({ cafeId, ...done }, "win-back run");
    totals.lapsed += done.lapsed;
    totals.offered += done.offered;
    totals.expired += done.expired;
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${String(failures.length)} parts of the cafés' win-back runs failed.`);
  }
  return totals;
}

/** Records the café's newly lapsed cards (see runWinBack); returns how many. */
async function recordLapses(trx: Transaction<Database>, cafeId: string): Promise<number> {
  const { rows } = await sql<{ card_id: string }>`
    WITH last_visits AS (
      SELECT card_id, max(occurred_at) AS last_visit_at
        FROM visits
       WHERE card_id IS NOT NULL AND outcome NOT IN ('held', 'discarded')
       GROUP BY card_id
      HAVING max(occurred_at) < now() - ${LAPSE_MIN_DAYS}::int * interval '1 day'
    ), candidates AS (
      SELECT last_visits.card_id, last_visits.last_visit_at
        FROM last_visits
       WHERE NOT EXISTS (SELECT 1 FROM card_lapses WHERE card_lapses.card_id = last_visits.card_id AND card_lapses.last_visit_at = last_visits.last_visit_at)
    ), visit_days AS (
      SELECT DISTINCT visits.card_id, (visits.occurred_at AT TIME ZONE cafes.time_zone)::date AS day
        FROM visits
        JOIN candidates ON candidates.card_id = visits.card_id
        JOIN cafes ON cafes.id = visits.cafe_id
       WHERE visits.outcome NOT IN ('held', 'discarded')
    ), per_card AS (
      SELECT card_id, count(*) AS days, percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap_days
        FROM (SELECT card_id, day - lag(day) OVER (PARTITION BY card_id ORDER BY day) AS gap FROM visit_days) AS gaps
       GROUP BY card_id
    )
    INSERT INTO card_lapses (cafe_id, card_id, last_visit_at)
    SELECT ${cafeId}::uuid, candidates.card_id, candidates.last_visit_at
      FROM candidates
      JOIN per_card ON per_card.card_id = candidates.card_id
      JOIN cards ON cards.id = candidates.card_id
     WHERE per_card.days >= ${LAPSE_MIN_VISITS}::int
       AND now() - candidates.last_visit_at > greatest(2 * coalesce(per_card.median_gap_days, 0) * interval '1 day', ${LAPSE_MIN_DAYS}::int * interval '1 day')
     ORDER BY candidates.card_id
     LIMIT ${WIN_BACK_BATCH}::int
    ON CONFLICT (card_id, last_visit_at) DO NOTHING
    RETURNING card_id`.execute(trx);
  return rows.length;
}

/** Gives the café's win-back offer to the lapsed cards now eligible (see runWinBack); returns their ids. */
async function giveOffers(trx: Transaction<Database>, cafeId: string): Promise<string[]> {
  // NO KEY UPDATE, like the campaign announcer: serializes the two without blocking inserts that reference the café.
  await trx.selectFrom("cafes").select("id").where("id", "=", cafeId).forNoKeyUpdate().executeTakeFirstOrThrow();
  const { rows } = await sql<{ card_id: string }>`
    UPDATE card_lapses
       SET offered_at = now(),
           discount_kind = cafes.win_back_discount_kind,
           discount_value = cafes.win_back_discount_value,
           min_margin_percent = cafes.min_margin_percent,
           expires_at = now() + ${WIN_BACK_OFFER_DAYS}::int * interval '1 day'
      FROM cafes
     WHERE cafes.id = ${cafeId}::uuid
       AND cafes.win_back_discount_kind IS NOT NULL
       AND card_lapses.id IN (
         SELECT lapse.id
           FROM card_lapses AS lapse
           JOIN cards ON cards.id = lapse.card_id
           JOIN cafes AS cafe ON cafe.id = lapse.cafe_id
          WHERE lapse.offered_at IS NULL
            AND cards.offers_opt_in_at IS NOT NULL
            -- Still lapsed: no member visit since.
            AND NOT EXISTS (
              SELECT 1 FROM visits
               WHERE visits.card_id = lapse.card_id AND visits.occurred_at > lapse.last_visit_at AND visits.outcome NOT IN ('held', 'discarded')
            )
            -- The cool-down, which also covers an offer given today (it is at least WIN_BACK_OFFER_DAYS).
            AND NOT EXISTS (
              SELECT 1 FROM card_lapses AS earlier
               WHERE earlier.card_id = lapse.card_id AND earlier.offered_at > now() - cafe.win_back_cooldown_days * interval '1 day'
            )
            -- Told of a campaign today: given the offer on a later run (AC 14).
            AND NOT EXISTS (
              SELECT 1 FROM campaign_announcements
               WHERE campaign_announcements.card_id = lapse.card_id
                 AND campaign_announcements.announced_at >= date_trunc('day', now() AT TIME ZONE cafe.time_zone) AT TIME ZONE cafe.time_zone
            )
          ORDER BY lapse.created_at, lapse.id
          LIMIT ${WIN_BACK_BATCH}::int
       )
    RETURNING card_lapses.card_id`.execute(trx);
  return rows.map((row) => row.card_id);
}
