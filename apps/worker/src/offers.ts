import { APPLE_PASS_UPDATE_QUEUE, GOOGLE_PASS_UPDATE_QUEUE, sendInTransaction, withCafe, type Database, type PgBoss } from "@cafe-loyalty/db";
import { sql, type Kysely } from "kysely";
import type { Logger } from "pino";

/** Announces running campaigns on opted-in cards' passes. */
export const ANNOUNCE_QUEUE = "announce-campaign-offers";
/** Every 5 minutes, so an offer is announced within minutes of its window opening. */
export const ANNOUNCE_CRON = "*/5 * * * *";
/** A campaign is announced only while at least this much of its window is left: no notification for an offer about to end. */
export const ANNOUNCE_MIN_MINUTES_LEFT = 15;
/** Cards announced per campaign per run. ponytail: a fixed batch; the next run, 5 minutes on, takes the rest. */
export const ANNOUNCE_BATCH = 500;

/**
 * Announces each campaign whose window is open now (with ANNOUNCE_MIN_MINUTES_LEFT to go) to the cards opted in to
 * offers (AC 4), once per campaign and card, and to a card at most once a day in the café's time zone, so a card gets
 * at most one notifying pass update a day (AC 14). The campaigns come from a function that runs as the owner role and
 * returns ids only (migration 0013); each café's announcements are made inside withCafe, holding the café's row, so two
 * runs cannot both pass the daily cap. An announcement marks the card's passes changed (a trigger), and their updates
 * are queued in the same transaction.
 */
export async function announceCampaigns(boss: PgBoss, db: Kysely<Database>, logger: Logger): Promise<{ campaigns: number; cards: number }> {
  const { rows } = await boss.getDb().executeSql("SELECT cafe_id, campaign_id FROM app.campaigns_to_announce($1)", [ANNOUNCE_MIN_MINUTES_LEFT]);
  let cards = 0;
  const failures: unknown[] = [];
  for (const { cafe_id: cafeId, campaign_id: campaignId } of rows as { cafe_id: string; campaign_id: string }[]) {
    // One café's failure leaves the others announced; the job fails afterwards, for pg-boss to retry.
    const announced = await withCafe(db, cafeId, async (trx) => {
      // NO KEY UPDATE: serializes announcers without blocking inserts that reference the café (stamps' audit rows).
      await trx.selectFrom("cafes").select("id").where("id", "=", cafeId).forNoKeyUpdate().executeTakeFirstOrThrow();
      const inserted = await trx
        .insertInto("campaign_announcements")
        .columns(["cafe_id", "campaign_id", "card_id"])
        .expression((eb) =>
          eb
            .selectFrom("cards")
            .innerJoin("cafes", "cafes.id", "cards.cafe_id")
            .innerJoin("campaigns", "campaigns.cafe_id", "cards.cafe_id")
            .select(["cards.cafe_id", "campaigns.id as campaign_id", "cards.id as card_id"])
            .where("campaigns.id", "=", campaignId)
            // Ended since the campaigns were listed: nothing to announce.
            .where("campaigns.ended_at", "is", null)
            .where("cards.offers_opt_in_at", "is not", null)
            .where((outer) =>
              outer.not(
                outer.exists(
                  outer
                    .selectFrom("campaign_announcements")
                    .select("campaign_announcements.card_id")
                    .whereRef("campaign_announcements.card_id", "=", "cards.id")
                    .where((inner) =>
                      inner.or([
                        inner("campaign_announcements.campaign_id", "=", campaignId),
                        inner("campaign_announcements.announced_at", ">=", sql<Date>`date_trunc('day', now() AT TIME ZONE cafes.time_zone) AT TIME ZONE cafes.time_zone`),
                      ]),
                    ),
                ),
              ),
            )
            .orderBy("cards.id")
            .limit(ANNOUNCE_BATCH),
        )
        .returning("card_id")
        .execute();
      // The passes this transaction changed are those of the cards just announced.
      const changedNow = sql<string>`pg_current_xact_id()`;
      const apple = await trx.selectFrom("apple_passes").select("id").where("updated_xid", "=", changedNow).execute();
      const google = await trx.selectFrom("google_passes").select("id").where("updated_xid", "=", changedNow).execute();
      for (const [queue, passes] of [
        [APPLE_PASS_UPDATE_QUEUE, apple],
        [GOOGLE_PASS_UPDATE_QUEUE, google],
      ] as const) {
        for (const pass of passes) {
          await sendInTransaction(boss, trx, queue, { cafeId, passId: pass.id }, { singletonKey: pass.id });
        }
      }
      return inserted.length;
    }).catch((error: unknown) => {
      logger.error({ err: error, cafeId, campaignId }, "campaign announcement failed");
      failures.push(error);
      return 0;
    });
    logger.info({ cafeId, campaignId, cards: announced }, "campaign announced");
    cards += announced;
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${String(failures.length)} of ${String(rows.length)} campaign announcements failed.`);
  }
  return { campaigns: rows.length, cards };
}
