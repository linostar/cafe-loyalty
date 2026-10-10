import { withCafe, type Database } from "@cafe-loyalty/db";
import { RESULTS_WINDOW_DAYS, type ResultsReport } from "@cafe-loyalty/shared";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { ownerOf } from "./access.js";

export interface ResultsRoutesOptions {
  db: Kysely<Database>;
}

interface ReportRow {
  window_from: Date | null;
  window_to: Date | null;
  complete: boolean | null;
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
 * The first-month results report (AC 38), owner only: the RESULTS_WINDOW_DAYS days from the café's first member visit
 * (a visit not held or discarded). Customers won back are lapsed cards (card_lapses, AC 36) with a member visit after
 * the last visit they lapsed from, inside the window; an offer's cost is the discount on its lines (unit discount
 * times quantity) and its revenue the totals of the visits that had it, win-back lines and quiet-hour campaign lines
 * apart (a visit with both kinds of line counts under each).
 */
export function resultsRoutes(app: FastifyInstance, options: ResultsRoutesOptions, done: (error?: Error) => void): void {
  const { db } = options;

  app.get("/results", { config: { access: "owner" } }, async (request): Promise<ResultsReport> => {
    const owner = ownerOf(request);
    const row = await withCafe(db, owner.cafeId, async (trx) => {
      const { rows } = await sql<ReportRow>`
        WITH first_visit AS (
          SELECT min(occurred_at) AS at FROM visits WHERE outcome NOT IN ('held', 'discarded')
        ), bounds AS (
          SELECT at AS window_from, at + ${RESULTS_WINDOW_DAYS}::int * interval '1 day' AS window_to FROM first_visit
        ), member_visits AS (
          SELECT visits.id, visits.card_id, visits.occurred_at, visits.total_cents
            FROM visits, bounds
           WHERE visits.outcome NOT IN ('held', 'discarded')
             AND visits.occurred_at >= bounds.window_from AND visits.occurred_at < bounds.window_to
        ), offer_lines AS (
          SELECT visit_items.visit_id, visit_items.win_back, visit_items.unit_discount_cents * visit_items.quantity AS discount
            FROM visit_items JOIN member_visits ON member_visits.id = visit_items.visit_id
           WHERE visit_items.win_back OR visit_items.campaign_id IS NOT NULL
        ), offer_visits AS (
          SELECT offer_lines.visit_id, offer_lines.win_back, sum(offer_lines.discount) AS cost, max(member_visits.total_cents) AS revenue
            FROM offer_lines JOIN member_visits ON member_visits.id = offer_lines.visit_id
           GROUP BY offer_lines.visit_id, offer_lines.win_back
        )
        SELECT bounds.window_from, bounds.window_to, bounds.window_to <= now() AS complete,
               (SELECT count(*) FROM member_visits) AS member_visits,
               (SELECT count(DISTINCT card_lapses.card_id) FROM card_lapses
                 WHERE EXISTS (SELECT 1 FROM member_visits WHERE member_visits.card_id = card_lapses.card_id AND member_visits.occurred_at > card_lapses.last_visit_at)) AS won_back,
               (SELECT count(*) FROM offer_visits WHERE NOT win_back) AS quiet_hour_visits,
               (SELECT count(*) FROM redemptions WHERE redeemed_at >= bounds.window_from AND redeemed_at < bounds.window_to) AS redemptions,
               (SELECT count(*) FROM offer_visits WHERE win_back) AS win_back_visits,
               (SELECT coalesce(sum(cost), 0) FROM offer_visits WHERE win_back) AS win_back_cost,
               (SELECT coalesce(sum(revenue), 0) FROM offer_visits WHERE win_back) AS win_back_revenue,
               (SELECT coalesce(sum(cost), 0) FROM offer_visits WHERE NOT win_back) AS quiet_hour_cost,
               (SELECT coalesce(sum(revenue), 0) FROM offer_visits WHERE NOT win_back) AS quiet_hour_revenue
          FROM bounds`.execute(trx);
      return rows[0];
    });
    const number = (value: string | undefined): number => Number(value ?? 0);
    return {
      window:
        row?.window_from === undefined || row.window_from === null || row.window_to === null
          ? null
          : { from: row.window_from.toISOString(), to: row.window_to.toISOString(), complete: row.complete === true },
      memberVisits: number(row?.member_visits),
      customersWonBack: number(row?.won_back),
      quietHourVisits: number(row?.quiet_hour_visits),
      rewardRedemptions: number(row?.redemptions),
      offers: {
        winBack: { visits: number(row?.win_back_visits), costCents: number(row?.win_back_cost), revenueCents: number(row?.win_back_revenue) },
        quietHour: { visits: number(row?.quiet_hour_visits), costCents: number(row?.quiet_hour_cost), revenueCents: number(row?.quiet_hour_revenue) },
      },
    };
  });

  done();
}
