import type { Discount } from "@cafe-loyalty/shared";
import { sql, type Transaction } from "kysely";
import type { Database } from "./schema.js";

/** The offer a card's passes show: its latest announced campaign (AC 14), while that campaign runs. */
export interface CardOffer {
  campaignId: string;
  nameAr: string;
  nameEn: string;
  discount: Discount;
  weekdays: number[];
  startsMinute: number;
  endsMinute: number;
  orderTypes: { nameAr: string; nameEn: string }[];
  announcedAt: Date;
  /**
   * Whether the offer may notify (AC 14): announced today in the café's time zone (a late fetch stays silent) to a card
   * opted in by then (opting out and in again shows it silently).
   */
  mayNotify: boolean;
}

/**
 * What a card's passes show of offers, inside withCafe for its café: whether the card is opted in (AC 4; only then do
 * passes have an offer field) and, if so, its latest announcement while that campaign runs. An ended latest campaign
 * shows no offer rather than an older one, so the offer shown changes only when one is announced.
 */
export async function loadCardOffer(trx: Transaction<Database>, cardId: string): Promise<{ optedIn: boolean; offer: CardOffer | undefined }> {
  const card = await trx.selectFrom("cards").select("offers_opt_in_at").where("id", "=", cardId).executeTakeFirst();
  if (card?.offers_opt_in_at == null) {
    return { optedIn: false, offer: undefined };
  }
  const latest = await trx
    .selectFrom("campaign_announcements")
    .innerJoin("campaigns", "campaigns.id", "campaign_announcements.campaign_id")
    .innerJoin("cafes", "cafes.id", "campaign_announcements.cafe_id")
    .select([
      "campaigns.id",
      "campaigns.name_ar",
      "campaigns.name_en",
      "campaigns.discount_kind",
      "campaigns.discount_value",
      "campaigns.weekdays",
      "campaigns.starts_minute",
      "campaigns.ends_minute",
      "campaigns.ended_at",
      "campaign_announcements.announced_at",
      sql<boolean>`campaign_announcements.announced_at >= date_trunc('day', now() AT TIME ZONE cafes.time_zone) AT TIME ZONE cafes.time_zone
        AND ${card.offers_opt_in_at} <= campaign_announcements.announced_at`.as("may_notify"),
    ])
    .where("campaign_announcements.card_id", "=", cardId)
    .orderBy("campaign_announcements.announced_at", "desc")
    .orderBy("campaigns.id")
    .limit(1)
    .executeTakeFirst();
  // No announcement, or its campaign ended.
  if (latest?.ended_at !== null) {
    return { optedIn: true, offer: undefined };
  }
  const orderTypes = await trx
    .selectFrom("campaign_order_types")
    .innerJoin("order_types", "order_types.id", "campaign_order_types.order_type_id")
    .select(["order_types.name_ar", "order_types.name_en"])
    .where("campaign_order_types.campaign_id", "=", latest.id)
    .orderBy("order_types.sort_order")
    .orderBy("order_types.name_en")
    .execute();
  return {
    optedIn: true,
    offer: {
      campaignId: latest.id,
      nameAr: latest.name_ar,
      nameEn: latest.name_en,
      discount: latest.discount_kind === "percent" ? { kind: "percent", value: latest.discount_value } : { kind: "amount", value: latest.discount_value },
      weekdays: latest.weekdays,
      startsMinute: latest.starts_minute,
      endsMinute: latest.ends_minute,
      orderTypes: orderTypes.map((type) => ({ nameAr: type.name_ar, nameEn: type.name_en })),
      announcedAt: latest.announced_at,
      mayNotify: latest.may_notify,
    },
  };
}
