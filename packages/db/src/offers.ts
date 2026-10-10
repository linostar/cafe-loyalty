import type { Discount } from "@cafe-loyalty/shared";
import { sql, type Transaction } from "kysely";
import type { Database } from "./schema.js";

/**
 * The offer a card's passes show (AC 14): its latest announced campaign, while that campaign runs, or its win-back
 * offer (AC 36), until used or expired, whichever it was given last.
 */
export type CardOffer = {
  announcedAt: Date;
  /**
   * Whether the offer may notify (AC 14): announced today in the café's time zone (a late fetch stays silent) to a card
   * opted in by then (opting out and in again shows it silently).
   */
  mayNotify: boolean;
} & (
  | {
      kind: "campaign";
      campaignId: string;
      nameAr: string;
      nameEn: string;
      discount: Discount;
      weekdays: number[];
      startsMinute: number;
      endsMinute: number;
      orderTypes: { nameAr: string; nameEn: string }[];
    }
  | {
      kind: "win_back";
      offerId: string;
      discount: Discount;
      /** The offer's last day, in the café's time zone (YYYY-MM-DD). */
      lastDay: string;
    }
);

/** An offer's id among a card's offers, for Google's message ids and the logs. */
export const offerKey = (offer: CardOffer): string => (offer.kind === "campaign" ? `offer-${offer.campaignId}` : `winback-${offer.offerId}`);

const discountOf = (kind: "percent" | "amount", value: number): Discount => (kind === "percent" ? { kind: "percent", value } : { kind: "amount", value });

/**
 * What a card's passes show of offers, inside withCafe for its café: whether the card is opted in (AC 4; only then do
 * passes have an offer field) and, if so, the offer it was given last, while it holds. An ended campaign or a used or
 * expired win-back offer shows no offer rather than an older one, so the offer shown changes only when one is given.
 */
export async function loadCardOffer(trx: Transaction<Database>, cardId: string): Promise<{ optedIn: boolean; offer: CardOffer | undefined }> {
  const card = await trx.selectFrom("cards").select("offers_opt_in_at").where("id", "=", cardId).executeTakeFirst();
  if (card?.offers_opt_in_at == null) {
    return { optedIn: false, offer: undefined };
  }
  const optedInAt = card.offers_opt_in_at;
  const mayNotify = (column: "campaign_announcements.announced_at" | "card_lapses.offered_at") =>
    sql<boolean>`${sql.ref(column)} >= date_trunc('day', now() AT TIME ZONE cafes.time_zone) AT TIME ZONE cafes.time_zone
      AND ${optedInAt} <= ${sql.ref(column)}`.as("may_notify");
  const campaign = await trx
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
      mayNotify("campaign_announcements.announced_at"),
    ])
    .where("campaign_announcements.card_id", "=", cardId)
    .orderBy("campaign_announcements.announced_at", "desc")
    .orderBy("campaigns.id")
    .limit(1)
    .executeTakeFirst();
  const winBack = await trx
    .selectFrom("card_lapses")
    .innerJoin("cafes", "cafes.id", "card_lapses.cafe_id")
    .select([
      "card_lapses.id",
      "card_lapses.discount_kind",
      "card_lapses.discount_value",
      "card_lapses.offered_at",
      sql<boolean>`card_lapses.closed_at IS NULL AND card_lapses.expires_at > now()`.as("open"),
      sql<string>`to_char((card_lapses.expires_at AT TIME ZONE cafes.time_zone)::date, 'YYYY-MM-DD')`.as("last_day"),
      mayNotify("card_lapses.offered_at"),
    ])
    .where("card_lapses.card_id", "=", cardId)
    .where("card_lapses.offered_at", "is not", null)
    .orderBy("card_lapses.offered_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (winBack?.offered_at != null && (campaign === undefined || winBack.offered_at > campaign.announced_at)) {
    if (!winBack.open || winBack.discount_kind === null || winBack.discount_value === null) {
      return { optedIn: true, offer: undefined };
    }
    return {
      optedIn: true,
      offer: {
        kind: "win_back",
        offerId: winBack.id,
        discount: discountOf(winBack.discount_kind, winBack.discount_value),
        lastDay: winBack.last_day,
        announcedAt: winBack.offered_at,
        mayNotify: winBack.may_notify,
      },
    };
  }
  // No announcement, or its campaign ended.
  if (campaign?.ended_at !== null) {
    return { optedIn: true, offer: undefined };
  }
  const orderTypes = await trx
    .selectFrom("campaign_order_types")
    .innerJoin("order_types", "order_types.id", "campaign_order_types.order_type_id")
    .select(["order_types.name_ar", "order_types.name_en"])
    .where("campaign_order_types.campaign_id", "=", campaign.id)
    .orderBy("order_types.sort_order")
    .orderBy("order_types.name_en")
    .execute();
  return {
    optedIn: true,
    offer: {
      kind: "campaign",
      campaignId: campaign.id,
      nameAr: campaign.name_ar,
      nameEn: campaign.name_en,
      discount: discountOf(campaign.discount_kind, campaign.discount_value),
      weekdays: campaign.weekdays,
      startsMinute: campaign.starts_minute,
      endsMinute: campaign.ends_minute,
      orderTypes: orderTypes.map((type) => ({ nameAr: type.name_ar, nameEn: type.name_en })),
      announcedAt: campaign.announced_at,
      mayNotify: campaign.may_notify,
    },
  };
}
