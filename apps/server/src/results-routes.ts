import { withCafe, type Database } from "@cafe-loyalty/db";
import { resultsQuerySchema, type ResultsReport } from "@cafe-loyalty/shared";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { ownerOf } from "./access.js";
import { parseInput } from "./http-errors.js";

export interface ResultsRoutesOptions {
  db: Kysely<Database>;
}

interface ReportRow {
  month: string;
  current: boolean;
  months: string[];
  member_visits: string;
  won_back: string;
  quiet_hour_visits: string;
  redemptions: string;
  win_back_visits: string;
  win_back_cost: string;
  win_back_revenue: string;
  quiet_hour_cost: string;
  quiet_hour_revenue: string;
}

/**
 * The results report (AC 38), owner only: one calendar month (`?month=YYYY-MM`, else the current one) in the café's
 * time zone, bucketed in PostgreSQL by when each visit happened (occurred_at), with the months from the one of the
 * café's first member visit (a visit not held or discarded) to the current one. Customers won back are lapsed cards
 * (card_lapses, AC 36) with a member visit in the month after the last visit they lapsed from; an offer's cost is the
 * discount on its lines (unit discount times quantity) and its revenue the totals of the visits that had it, win-back
 * lines and quiet-hour campaign lines apart (a visit with both kinds of line counts under each).
 */
export function resultsRoutes(app: FastifyInstance, options: ResultsRoutesOptions, done: (error?: Error) => void): void {
  const { db } = options;

  app.get("/results", { config: { access: "owner" } }, async (request): Promise<ResultsReport> => {
    const owner = ownerOf(request);
    const { month } = parseInput(resultsQuerySchema, request.query);
    const row = await withCafe(db, owner.cafeId, async (trx) => {
      const { rows } = await sql<ReportRow>`
        WITH cafe AS (
          SELECT time_zone, date_trunc('month', now() AT TIME ZONE time_zone) AS current_month FROM cafes WHERE id = ${owner.cafeId}
        ), bounds AS (
          SELECT coalesce((${month ?? null}::text || '-01')::timestamp, cafe.current_month) AS month,
                 date_trunc('month', (SELECT min(occurred_at) FROM visits WHERE outcome NOT IN ('held', 'discarded')) AT TIME ZONE cafe.time_zone) AS first_month
            FROM cafe
        ), member_visits AS (
          SELECT visits.id, visits.card_id, visits.occurred_at, visits.total_cents
            FROM visits, cafe, bounds
           WHERE visits.outcome NOT IN ('held', 'discarded')
             AND date_trunc('month', visits.occurred_at AT TIME ZONE cafe.time_zone) = bounds.month
        ), offer_lines AS (
          SELECT visit_items.visit_id, visit_items.win_back, visit_items.unit_discount_cents::bigint * visit_items.quantity AS discount
            FROM visit_items JOIN member_visits ON member_visits.id = visit_items.visit_id
           WHERE visit_items.win_back OR visit_items.campaign_id IS NOT NULL
        ), offer_visits AS (
          SELECT offer_lines.visit_id, offer_lines.win_back, sum(offer_lines.discount) AS cost, max(member_visits.total_cents) AS revenue
            FROM offer_lines JOIN member_visits ON member_visits.id = offer_lines.visit_id
           GROUP BY offer_lines.visit_id, offer_lines.win_back
        )
        SELECT to_char(bounds.month, 'YYYY-MM') AS month, bounds.month = cafe.current_month AS current,
               ARRAY(SELECT to_char(listed, 'YYYY-MM')
                       FROM generate_series(cafe.current_month, least(coalesce(bounds.first_month, cafe.current_month), cafe.current_month), interval '-1 month') AS listed) AS months,
               (SELECT count(*) FROM member_visits) AS member_visits,
               (SELECT count(DISTINCT card_lapses.card_id) FROM card_lapses
                 WHERE EXISTS (SELECT 1 FROM member_visits WHERE member_visits.card_id = card_lapses.card_id AND member_visits.occurred_at > card_lapses.last_visit_at)) AS won_back,
               (SELECT count(*) FROM offer_visits WHERE NOT win_back) AS quiet_hour_visits,
               (SELECT count(*) FROM redemptions WHERE date_trunc('month', redeemed_at AT TIME ZONE cafe.time_zone) = bounds.month) AS redemptions,
               (SELECT count(*) FROM offer_visits WHERE win_back) AS win_back_visits,
               (SELECT coalesce(sum(cost), 0) FROM offer_visits WHERE win_back) AS win_back_cost,
               (SELECT coalesce(sum(revenue), 0) FROM offer_visits WHERE win_back) AS win_back_revenue,
               (SELECT coalesce(sum(cost), 0) FROM offer_visits WHERE NOT win_back) AS quiet_hour_cost,
               (SELECT coalesce(sum(revenue), 0) FROM offer_visits WHERE NOT win_back) AS quiet_hour_revenue
          FROM cafe, bounds`.execute(trx);
      return rows[0];
    });
    if (row === undefined) {
      throw new Error("The owner's café row was not found.");
    }
    return {
      month: row.month,
      current: row.current,
      months: row.months,
      memberVisits: Number(row.member_visits),
      customersWonBack: Number(row.won_back),
      quietHourVisits: Number(row.quiet_hour_visits),
      rewardRedemptions: Number(row.redemptions),
      offers: {
        winBack: { visits: Number(row.win_back_visits), costCents: Number(row.win_back_cost), revenueCents: Number(row.win_back_revenue) },
        quietHour: { visits: Number(row.quiet_hour_visits), costCents: Number(row.quiet_hour_cost), revenueCents: Number(row.quiet_hour_revenue) },
      },
    };
  });

  done();
}
