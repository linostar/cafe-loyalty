import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useApiHarness, withCookie } from "./testing/api-harness.js";

const context = useApiHarness();
const { harness, signUp, issueCard } = context;
const EMPTY = { winBack: { visits: 0, costCents: 0, revenueCents: 0 }, quietHour: { visits: 0, costCents: 0, revenueCents: 0 } };

interface Line {
  quantity: number;
  unitPriceCents: number;
  unitDiscountCents?: number;
  campaign?: boolean;
  winBack?: boolean;
}

/**
 * Bare rows (no device, staff, campaign or signed event behind them, so their foreign keys are not checked), as the
 * worker's tests make visits: the report reads only these tables.
 */
async function asReplica<T>(work: () => Promise<T>): Promise<T> {
  await context.admin.query("SET session_replication_role = replica");
  try {
    return await work();
  } finally {
    await context.admin.query("SET session_replication_role = DEFAULT");
  }
}

/** A visit at `at` (an ISO timestamp). */
async function visit(cafeId: string, cardId: string | null, at: string, lines: Line[], outcome = "stamped"): Promise<string> {
  const total = lines.reduce((sum, line) => sum + line.quantity * (line.unitPriceCents - (line.unitDiscountCents ?? 0)), 0);
  return asReplica(async () => {
    const { rows } = await context.admin.query<{ id: string }>(
      `INSERT INTO app.visits (cafe_id, sync_event_id, card_id, identified_by, device_id, staff_id, occurred_at, total_cents, stamps_earned, stamps_added, outcome)
       VALUES ($1, gen_random_uuid(), $2, 'qr', gen_random_uuid(), gen_random_uuid(), $3, $4, 1, 1, $5) RETURNING id`,
      [cafeId, cardId, at, total, outcome],
    );
    const visitId = rows[0]?.id ?? "missing";
    for (const [index, line] of lines.entries()) {
      await context.admin.query(
        `INSERT INTO app.visit_items (cafe_id, visit_id, line, order_type_id, quantity, unit_price_cents, unit_cost_cents, catalog_version, stamps_each, campaign_id, unit_discount_cents, win_back)
         VALUES ($1, $2, $3, gen_random_uuid(), $4, $5, 90, 1, 1, $6, $7, $8)`,
        [cafeId, visitId, index + 1, line.quantity, line.unitPriceCents, line.campaign === true ? randomUUID() : null, line.unitDiscountCents ?? 0, line.winBack === true],
      );
    }
    return visitId;
  });
}

async function redemption(cafeId: string, cardId: string, at: string): Promise<void> {
  await asReplica(() =>
    context.admin.query(
      "INSERT INTO app.redemptions (cafe_id, device_id, event_id, card_id, staff_id, stamps_used, stamps_left, redeemed_at) VALUES ($1, gen_random_uuid(), gen_random_uuid(), $2, gen_random_uuid(), 9, 0, $3)",
      [cafeId, cardId, at],
    ),
  );
}

async function lapse(cafeId: string, cardId: string, lastVisitAt: string): Promise<void> {
  await context.admin.query("INSERT INTO app.card_lapses (cafe_id, card_id, last_visit_at) VALUES ($1, $2, $3)", [cafeId, cardId, lastVisitAt]);
}

/** The café's current month, as PostgreSQL sees it in the café's time zone. */
async function currentMonth(cafeId: string): Promise<string> {
  const { rows } = await context.admin.query<{ month: string }>("SELECT to_char(now() AT TIME ZONE time_zone, 'YYYY-MM') AS month FROM app.cafes WHERE id = $1", [cafeId]);
  return rows[0]?.month ?? "missing";
}

/** The months from `current` back to `first`, newest first. */
function monthsBack(current: string, first: string): string[] {
  const months: string[] = [];
  for (let at = new Date(`${current}-01T00:00:00Z`); at.toISOString().slice(0, 7) >= first; at.setUTCMonth(at.getUTCMonth() - 1)) {
    months.push(at.toISOString().slice(0, 7));
  }
  return months;
}

async function ownerApp() {
  const h = await harness();
  const owner = await signUp(h.app);
  const report = async (month?: string) => {
    const response = await h.app.inject({ method: "GET", url: month === undefined ? "/api/results" : `/api/results?month=${month}`, headers: withCookie(owner.session) });
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  };
  return { ...h, owner, report };
}

describe("results by month (AC 38)", () => {
  it("reports the café's current month by default, the only one to pick before its first member visit", async () => {
    const { owner, report } = await ownerApp();
    // A held visit does not start the months.
    await visit(owner.cafeId, null, "2026-03-10T10:00:00Z", [{ quantity: 1, unitPriceCents: 300 }], "held");
    const current = await currentMonth(owner.cafeId);
    expect(await report()).toEqual({
      month: current,
      current: true,
      months: [current],
      memberVisits: 0,
      customersWonBack: 0,
      quietHourVisits: 0,
      rewardRedemptions: 0,
      offers: EMPTY,
    });
  });

  it("counts a month's customers won back, quiet-hour visits, redemptions and offer cost against revenue", async () => {
    const { owner, report } = await ownerApp();
    const regular = await issueCard(owner.cafeId);
    const lapsed = await issueCard(owner.cafeId);
    const stillAway = await issueCard(owner.cafeId);
    const before = await issueCard(owner.cafeId);
    // The café's first member visit, in February: the months start there.
    await visit(owner.cafeId, lapsed.cardId, "2026-02-10T10:00:00Z", [{ quantity: 1, unitPriceCents: 300 }]);
    // Lapsed with no visit since: not won back.
    await visit(owner.cafeId, stillAway.cardId, "2026-03-02T10:00:00Z", [{ quantity: 1, unitPriceCents: 300 }]);
    await lapse(owner.cafeId, stillAway.cardId, "2026-03-02T10:00:00Z");
    // Its only visits are before the visit it lapsed from: not won back either.
    await visit(owner.cafeId, before.cardId, "2026-03-03T10:00:00Z", [{ quantity: 1, unitPriceCents: 300 }]);
    await lapse(owner.cafeId, before.cardId, "2026-03-09T10:00:00Z");
    // Quiet-hour campaign lines: 2 coffees at 60 cents off, and a full-price croissant on the same visit.
    await visit(owner.cafeId, regular.cardId, "2026-03-11T10:00:00Z", [
      { quantity: 2, unitPriceCents: 300, unitDiscountCents: 60, campaign: true },
      { quantity: 1, unitPriceCents: 250 },
    ]);
    await visit(owner.cafeId, null, "2026-03-12T10:00:00Z", [{ quantity: 1, unitPriceCents: 300, unitDiscountCents: 75, campaign: true }]);
    // The lapsed card comes back with its win-back offer.
    await lapse(owner.cafeId, lapsed.cardId, "2026-02-10T10:00:00Z");
    await visit(owner.cafeId, lapsed.cardId, "2026-03-20T10:00:00Z", [{ quantity: 1, unitPriceCents: 300, unitDiscountCents: 30, winBack: true }]);
    // Held and discarded visits do not count, offer or not.
    await visit(owner.cafeId, regular.cardId, "2026-03-21T10:00:00Z", [{ quantity: 1, unitPriceCents: 300, unitDiscountCents: 60, campaign: true }], "held");
    await visit(owner.cafeId, regular.cardId, "2026-03-22T10:00:00Z", [{ quantity: 1, unitPriceCents: 300, unitDiscountCents: 30, winBack: true }], "discarded");
    await redemption(owner.cafeId, regular.cardId, "2026-03-25T10:00:00Z");
    // Other months: not in March's report.
    await visit(owner.cafeId, null, "2026-04-02T10:00:00Z", [{ quantity: 1, unitPriceCents: 300, unitDiscountCents: 60, campaign: true }]);
    await redemption(owner.cafeId, regular.cardId, "2026-02-25T10:00:00Z");

    const current = await currentMonth(owner.cafeId);
    expect(await report("2026-03")).toEqual({
      month: "2026-03",
      current: false,
      months: monthsBack(current, "2026-02"),
      memberVisits: 5,
      customersWonBack: 1,
      quietHourVisits: 2,
      rewardRedemptions: 1,
      offers: {
        winBack: { visits: 1, costCents: 30, revenueCents: 270 },
        // 2 x 60 + 75 off; 730 + 225 taken.
        quietHour: { visits: 2, costCents: 195, revenueCents: 955 },
      },
    });
    // February: the first visit and a redemption; the card had not lapsed or come back yet.
    expect(await report("2026-02")).toMatchObject({ month: "2026-02", memberVisits: 1, customersWonBack: 0, rewardRedemptions: 1, offers: EMPTY });
  });

  it("buckets by the café's own calendar month, not UTC's", async () => {
    const { owner, report } = await ownerApp();
    const card = await issueCard(owner.cafeId);
    await context.admin.query("UPDATE app.cafes SET time_zone = 'America/New_York' WHERE id = $1", [owner.cafeId]);
    // 22:30 on 31 March in New York, already 1 April in UTC: March's.
    await visit(owner.cafeId, card.cardId, "2026-04-01T02:30:00Z", [{ quantity: 1, unitPriceCents: 300 }]);
    await redemption(owner.cafeId, card.cardId, "2026-04-01T02:40:00Z");
    // 00:30 on 1 April in New York: April's.
    await visit(owner.cafeId, card.cardId, "2026-04-01T04:30:00Z", [{ quantity: 1, unitPriceCents: 300 }]);
    // 23:00 on 28 February in New York, already 1 March in UTC: February's, which starts the months.
    await visit(owner.cafeId, null, "2026-03-01T04:00:00Z", [{ quantity: 1, unitPriceCents: 300 }]);
    expect(await report("2026-03")).toMatchObject({ memberVisits: 1, rewardRedemptions: 1 });
    expect(await report("2026-04")).toMatchObject({ memberVisits: 1, rewardRedemptions: 0 });
    expect(await report("2026-02")).toMatchObject({ memberVisits: 1, rewardRedemptions: 0 });
    expect((await report()).months).toEqual(monthsBack(await currentMonth(owner.cafeId), "2026-02"));
  });

  it("reports a month with no visits as zeros", async () => {
    const { owner, report } = await ownerApp();
    await visit(owner.cafeId, null, "2026-01-15T10:00:00Z", [{ quantity: 1, unitPriceCents: 300 }]);
    await visit(owner.cafeId, null, "2026-03-15T10:00:00Z", [{ quantity: 1, unitPriceCents: 300 }]);
    expect(await report("2026-02")).toMatchObject({ month: "2026-02", current: false, memberVisits: 0, customersWonBack: 0, quietHourVisits: 0, rewardRedemptions: 0, offers: EMPTY });
  });

  it("refuses a month not written as YYYY-MM", async () => {
    const { app, owner } = await ownerApp();
    for (const month of ["2026-13", "2026-1", "march", "1999-12"]) {
      const response = await app.inject({ method: "GET", url: `/api/results?month=${month}`, headers: withCookie(owner.session) });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "month", issue: "Choose a month as YYYY-MM, such as 2026-10." }] });
    }
  });

  it("adds up discounts beyond 32-bit integers", async () => {
    const { owner, report } = await ownerApp();
    // The largest line the database takes: 50 at $1,000,000, all of it off (5,000,000,000 cents, past 2^31).
    await visit(owner.cafeId, null, new Date().toISOString(), [{ quantity: 50, unitPriceCents: 100_000_000, unitDiscountCents: 100_000_000, campaign: true }]);
    expect(await report()).toMatchObject({ offers: { quietHour: { visits: 1, costCents: 5_000_000_000, revenueCents: 0 } } });
  });
});
