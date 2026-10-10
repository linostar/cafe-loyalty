import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useApiHarness, withCookie } from "./testing/api-harness.js";

const context = useApiHarness();
const { harness, signUp, issueCard } = context;
const DAY = 24 * 60 * 60 * 1000;

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

async function visit(cafeId: string, cardId: string | null, daysAgo: number, lines: Line[], outcome = "stamped"): Promise<string> {
  const total = lines.reduce((sum, line) => sum + line.quantity * (line.unitPriceCents - (line.unitDiscountCents ?? 0)), 0);
  return asReplica(async () => {
    const { rows } = await context.admin.query<{ id: string }>(
      `INSERT INTO app.visits (cafe_id, sync_event_id, card_id, identified_by, device_id, staff_id, occurred_at, total_cents, stamps_earned, stamps_added, outcome)
       VALUES ($1, gen_random_uuid(), $2, 'qr', gen_random_uuid(), gen_random_uuid(), now() - make_interval(days => $3), $4, 1, 1, $5) RETURNING id`,
      [cafeId, cardId, daysAgo, total, outcome],
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

async function ownerApp() {
  const h = await harness();
  const owner = await signUp(h.app);
  const report = async () => {
    const response = await h.app.inject({ method: "GET", url: "/api/results", headers: withCookie(owner.session) });
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  };
  return { ...h, owner, report };
}

describe("first-month results (AC 38)", () => {
  it("has no window before the café's first member visit", async () => {
    const { owner, report } = await ownerApp();
    // A held visit does not start it.
    await visit(owner.cafeId, null, 3, [{ quantity: 1, unitPriceCents: 300 }], "held");
    expect(await report()).toEqual({
      window: null,
      memberVisits: 0,
      customersWonBack: 0,
      quietHourVisits: 0,
      rewardRedemptions: 0,
      offers: { winBack: { visits: 0, costCents: 0, revenueCents: 0 }, quietHour: { visits: 0, costCents: 0, revenueCents: 0 } },
    });
  });

  it("counts the 30 days from the first member visit: customers won back, quiet-hour visits, redemptions and offer cost against revenue", async () => {
    const { owner, report } = await ownerApp();
    const regular = await issueCard(owner.cafeId);
    const lapsed = await issueCard(owner.cafeId);
    await visit(owner.cafeId, lapsed.cardId, 20, [{ quantity: 1, unitPriceCents: 300 }]);
    // Quiet-hour campaign lines: 2 coffees at 60 cents off, and a full-price croissant on the same visit.
    await visit(owner.cafeId, regular.cardId, 10, [
      { quantity: 2, unitPriceCents: 300, unitDiscountCents: 60, campaign: true },
      { quantity: 1, unitPriceCents: 250 },
    ]);
    await visit(owner.cafeId, null, 9, [{ quantity: 1, unitPriceCents: 300, unitDiscountCents: 75, campaign: true }]);
    // The lapsed card comes back with its win-back offer.
    await context.admin.query("INSERT INTO app.card_lapses (cafe_id, card_id, last_visit_at) VALUES ($1, $2, now() - interval '20 days')", [owner.cafeId, lapsed.cardId]);
    await visit(owner.cafeId, lapsed.cardId, 2, [{ quantity: 1, unitPriceCents: 300, unitDiscountCents: 30, winBack: true }]);
    // Held and discarded visits do not count, offer or not.
    await visit(owner.cafeId, regular.cardId, 3, [{ quantity: 1, unitPriceCents: 300, unitDiscountCents: 60, campaign: true }], "held");
    await visit(owner.cafeId, regular.cardId, 4, [{ quantity: 1, unitPriceCents: 300, unitDiscountCents: 30, winBack: true }], "discarded");
    await asReplica(() =>
      context.admin.query(
        "INSERT INTO app.redemptions (cafe_id, device_id, event_id, card_id, staff_id, stamps_used, stamps_left, redeemed_at) VALUES ($1, gen_random_uuid(), gen_random_uuid(), $2, gen_random_uuid(), 9, 0, now() - interval '1 day')",
        [owner.cafeId, regular.cardId],
      ),
    );

    const result = await report();
    const window = result.window as { from: string; to: string; complete: boolean };
    expect(Date.now() - new Date(window.from).getTime()).toBeGreaterThan(20 * DAY - 60_000);
    expect(new Date(window.to).getTime() - new Date(window.from).getTime()).toBe(30 * DAY);
    expect(result).toMatchObject({
      window: { complete: false },
      memberVisits: 4,
      customersWonBack: 1,
      quietHourVisits: 2,
      rewardRedemptions: 1,
      offers: {
        winBack: { visits: 1, costCents: 30, revenueCents: 270 },
        // 2 x 60 + 75 off; 730 + 225 taken.
        quietHour: { visits: 2, costCents: 195, revenueCents: 955 },
      },
    });
  });

  it("stops at the end of the first month", async () => {
    const { owner, report } = await ownerApp();
    await visit(owner.cafeId, null, 40, [{ quantity: 1, unitPriceCents: 300 }]);
    await visit(owner.cafeId, null, 11, [{ quantity: 1, unitPriceCents: 300 }]);
    // After the 30 days: not in the report.
    await visit(owner.cafeId, null, 5, [{ quantity: 1, unitPriceCents: 300, unitDiscountCents: 60, campaign: true }]);
    expect(await report()).toMatchObject({ window: { complete: true }, memberVisits: 2, quietHourVisits: 0, offers: { quietHour: { visits: 0 } } });
  });
});
