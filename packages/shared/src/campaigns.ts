/**
 * Quiet-hour campaign rules shared by the dashboard, the counter and the server (AC 35), in integer cents so all three
 * get the same answer. The server reads a visit's local weekday and minute from PostgreSQL (one time zone source for
 * its records); the counter reads them from the browser, offline.
 */

export const DISCOUNT_KINDS = ["percent", "amount"] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

/** A campaign's discount: percent off each unit (1-100), or a fixed amount off each unit in cents. */
export interface Discount {
  kind: DiscountKind;
  value: number;
}

/** What a campaign needs to price a line and to say when it runs. */
export interface CampaignTerms {
  /** ISO weekdays, 1 = Monday. */
  weekdays: readonly number[];
  /** Local minutes of the day, [startsMinute, endsMinute). */
  startsMinute: number;
  endsMinute: number;
  discount: Discount;
  minMarginPercent: number;
  orderTypeIds: readonly string[];
}

/** The discount on one unit priced `priceCents`: a percentage rounds down to the cent (in the café's favour). */
export const unitDiscountCents = (priceCents: number, discount: Discount): number =>
  Math.min(priceCents, discount.kind === "percent" ? Math.floor((priceCents * discount.value) / 100) : discount.value);

/** The least a unit costing `costCents` may sell for: its cost plus `minMarginPercent` of it, rounded up to the cent. */
export const marginFloorCents = (costCents: number, minMarginPercent: number): number => Math.ceil((costCents * (100 + minMarginPercent)) / 100);

/** Whether the discounted price of a unit stays at or above its margin floor. */
export const keepsMargin = (priceCents: number, costCents: number, discount: Discount, minMarginPercent: number): boolean =>
  priceCents - unitDiscountCents(priceCents, discount) >= marginFloorCents(costCents, minMarginPercent);

/** Whether a campaign runs at a local weekday (ISO) and minute of the day. */
export const runsAt = (campaign: Pick<CampaignTerms, "weekdays" | "startsMinute" | "endsMinute">, weekday: number, minute: number): boolean =>
  campaign.weekdays.includes(weekday) && minute >= campaign.startsMinute && minute < campaign.endsMinute;

/**
 * The discount a running campaign gives one unit of an order type at a local time, or null when none applies: the
 * campaign must run then, include the order type and keep its margin floor. With several, the largest discount wins.
 */
export function bestCampaign<T extends CampaignTerms>(
  campaigns: readonly T[],
  item: { orderTypeId: string; priceCents: number; costCents: number },
  weekday: number,
  minute: number,
): { campaign: T; unitDiscountCents: number } | null {
  let best: { campaign: T; unitDiscountCents: number } | null = null;
  for (const campaign of campaigns) {
    if (
      runsAt(campaign, weekday, minute) &&
      campaign.orderTypeIds.includes(item.orderTypeId) &&
      keepsMargin(item.priceCents, item.costCents, campaign.discount, campaign.minMarginPercent)
    ) {
      const discount = unitDiscountCents(item.priceCents, campaign.discount);
      if (discount > 0 && (best === null || discount > best.unitDiscountCents)) {
        best = { campaign, unitDiscountCents: discount };
      }
    }
  }
  return best;
}

/** How long a win-back offer lasts (AC 36), and so the shortest cool-down a café may set. */
export const WIN_BACK_OFFER_DAYS = 14;
/** The longest cool-down, and the default. */
export const WIN_BACK_MAX_COOLDOWN_DAYS = 365;
export const WIN_BACK_DEFAULT_COOLDOWN_DAYS = 30;

/**
 * The win-back discount on one unit (AC 36): the offer's discount, or none when it would sell the unit below its
 * margin floor. It applies to every order type; the counter gives a line the larger of this and its campaign's.
 */
export const winBackUnitDiscountCents = (item: { priceCents: number; costCents: number }, terms: { discount: Discount; minMarginPercent: number }): number =>
  keepsMargin(item.priceCents, item.costCents, terms.discount, terms.minMarginPercent) ? unitDiscountCents(item.priceCents, terms.discount) : 0;
