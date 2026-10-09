import { withCafe, type Database } from "@cafe-loyalty/db";
import {
  ApiError,
  MAX_RUNNING_CAMPAIGNS,
  campaignCreateSchema,
  formatUsd,
  keepsMargin,
  marginFloorCents,
  unitDiscountCents,
  type Campaign,
  type Campaigns,
  type ErrorDetail,
} from "@cafe-loyalty/shared";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { ownerOf } from "./access.js";
import { audit } from "./db-helpers.js";
import { parseInput } from "./http-errors.js";

export interface CampaignRoutesOptions {
  db: Kysely<Database>;
}

/**
 * How long after its end a campaign's discounts are still accepted: a counter learns of the end at its next catalog
 * refresh (every 5 minutes while online), so a barista who gave the discount meanwhile is not refused.
 */
export const CAMPAIGN_END_GRACE_MINUTES = 10;

/** A campaign counts from this long before it was made, for a counter whose clock runs a little behind the server's. */
export const CAMPAIGN_START_GRACE_MINUTES = 5;

/** Ended campaigns the dashboard lists, newest first; the running ones are capped by MAX_RUNNING_CAMPAIGNS. */
const ENDED_LISTED = 20;

const idParams = z.object({ id: z.uuid("Use a campaign from the list.") });

/**
 * This café's campaigns, newest first, with their order types: those with `ids`, those running now (`runningNow`),
 * or, with `endedLimit`, the most recently ended ones.
 */
export async function loadCampaigns(trx: Transaction<Database>, filter: { ids?: readonly string[]; runningNow?: true; endedLimit?: number }): Promise<Campaign[]> {
  let query = trx.selectFrom("campaigns").selectAll();
  if (filter.ids !== undefined) {
    query = query.where("id", "in", filter.ids);
  }
  if (filter.runningNow === true) {
    query = query.where("ended_at", "is", null);
  }
  query =
    filter.endedLimit === undefined
      ? query.orderBy("created_at", "desc")
      : query.where("ended_at", "is not", null).orderBy("ended_at", "desc").limit(filter.endedLimit);
  const rows = await query.execute();
  if (rows.length === 0) {
    return [];
  }
  const types = await trx
    .selectFrom("campaign_order_types")
    .select(["campaign_id", "order_type_id"])
    .where(
      "campaign_id",
      "in",
      rows.map((row) => row.id),
    )
    .execute();
  return rows.map((row) => ({
    id: row.id,
    nameAr: row.name_ar,
    nameEn: row.name_en,
    weekdays: row.weekdays,
    startsMinute: row.starts_minute,
    endsMinute: row.ends_minute,
    discount: row.discount_kind === "percent" ? { kind: "percent", value: row.discount_value } : { kind: "amount", value: row.discount_value },
    minMarginPercent: row.min_margin_percent,
    orderTypeIds: types.filter((type) => type.campaign_id === row.id).map((type) => type.order_type_id),
    createdAt: row.created_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
  }));
}

const listCampaigns = async (trx: Transaction<Database>): Promise<Campaigns> => ({
  running: await loadCampaigns(trx, { runningNow: true }),
  ended: await loadCampaigns(trx, { endedLimit: ENDED_LISTED }),
});

/** Quiet-hour campaigns (AC 35): the owner makes them, refused below the margin floor, and ends them. */
export function campaignRoutes(app: FastifyInstance, options: CampaignRoutesOptions, done: (error?: Error) => void): void {
  const { db } = options;

  app.get("/campaigns", { config: { access: "owner" } }, async (request): Promise<Campaigns> => {
    const { cafeId } = ownerOf(request);
    return withCafe(db, cafeId, listCampaigns);
  });

  /**
   * Makes a campaign, refused if any of its order types would sell below cost plus the café's minimum margin once
   * discounted (AC 35). The campaign keeps that margin, so counters offline check the same floor the server does.
   */
  app.post("/campaigns", { config: { access: "owner" } }, async (request, reply) => {
    const owner = ownerOf(request);
    const body = parseInput(campaignCreateSchema, request.body);
    const campaigns = await withCafe(db, owner.cafeId, async (trx) => {
      // Locks the café row, so two campaigns made at once cannot both pass the cap.
      const cafe = await trx.selectFrom("cafes").select("min_margin_percent").where("id", "=", owner.cafeId).forUpdate().executeTakeFirstOrThrow();
      const running = await trx.selectFrom("campaigns").select(({ fn }) => fn.countAll<string>().as("count")).where("ended_at", "is", null).executeTakeFirstOrThrow();
      if (Number(running.count) >= MAX_RUNNING_CAMPAIGNS) {
        throw new ApiError("CONFLICT", `A café can run at most ${String(MAX_RUNNING_CAMPAIGNS)} campaigns at once. End one first.`);
      }
      const types = await trx
        .selectFrom("order_types")
        .select(["id", "name_en", "price_cents", "cost_cents"])
        .where("id", "in", body.orderTypeIds)
        .where("active", "=", true)
        .execute();
      if (types.length !== body.orderTypeIds.length) {
        throw new ApiError("VALIDATION_FAILED", "Pick order types that are on sale. Reload the page to see the current list.", [
          { path: "orderTypeIds", issue: "An order type is not on sale or no longer exists." },
        ]);
      }
      const margin = cafe.min_margin_percent;
      const belowFloor: ErrorDetail[] = types
        .filter((type) => !keepsMargin(type.price_cents, type.cost_cents, body.discount, margin))
        .map((type) => ({
          path: "orderTypeIds",
          issue: `${type.name_en} would sell for ${formatUsd(type.price_cents - unitDiscountCents(type.price_cents, body.discount), "en")}, below its floor of ${formatUsd(marginFloorCents(type.cost_cents, margin), "en")} (cost ${formatUsd(type.cost_cents, "en")} plus ${String(margin)}%).`,
        }));
      if (belowFloor.length > 0) {
        throw new ApiError(
          "VALIDATION_FAILED",
          "This discount takes some order types below your minimum margin. Lower the discount, or leave those order types out.",
          belowFloor,
        );
      }
      const { id } = await trx
        .insertInto("campaigns")
        .values({
          cafe_id: owner.cafeId,
          name_ar: body.nameAr,
          name_en: body.nameEn,
          weekdays: [...body.weekdays].sort((a, b) => a - b),
          starts_minute: body.startsMinute,
          ends_minute: body.endsMinute,
          discount_kind: body.discount.kind,
          discount_value: body.discount.value,
          min_margin_percent: margin,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("campaign_order_types")
        .values(body.orderTypeIds.map((orderTypeId) => ({ cafe_id: owner.cafeId, campaign_id: id, order_type_id: orderTypeId })))
        .execute();
      await audit(trx, {
        cafeId: owner.cafeId,
        actorType: "owner",
        actorId: owner.ownerId,
        action: "campaign.created",
        entityType: "campaign",
        entityId: id,
        changes: {
          weekdays: body.weekdays,
          startsMinute: body.startsMinute,
          endsMinute: body.endsMinute,
          discount: body.discount,
          minMarginPercent: margin,
          orderTypeIds: body.orderTypeIds,
        },
      });
      return listCampaigns(trx);
    });
    request.log.info({ cafeId: owner.cafeId }, "campaign created");
    return reply.code(201).send(campaigns);
  });

  /** Ends a running campaign; counters stop offering it at their next catalog refresh. */
  app.post("/campaigns/:id/end", { config: { access: "owner" } }, async (request) => {
    const owner = ownerOf(request);
    const { id } = parseInput(idParams, request.params);
    const campaigns = await withCafe(db, owner.cafeId, async (trx) => {
      const ended = await trx
        .updateTable("campaigns")
        .set({ ended_at: sql<Date>`now()` })
        .where("id", "=", id)
        .where("ended_at", "is", null)
        .returning("id")
        .executeTakeFirst();
      if (ended === undefined) {
        throw new ApiError("NOT_FOUND", "This campaign is not running. Reload the page to see the current list.");
      }
      await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "campaign.ended", entityType: "campaign", entityId: id });
      return listCampaigns(trx);
    });
    request.log.info({ cafeId: owner.cafeId }, "campaign ended");
    return campaigns;
  });

  done();
}
