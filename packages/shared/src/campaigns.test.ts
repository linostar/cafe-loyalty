import { describe, expect, it } from "vitest";
import { bestCampaign, keepsMargin, marginFloorCents, runsAt, unitDiscountCents, type CampaignTerms } from "./campaigns.js";

const quiet: CampaignTerms = {
  weekdays: [1, 2, 3],
  startsMinute: 15 * 60,
  endsMinute: 17 * 60,
  discount: { kind: "percent", value: 20 },
  minMarginPercent: 30,
  orderTypeIds: ["latte"],
};

describe("campaign rules (AC 35)", () => {
  it("rounds a percentage discount down to the cent and never discounts more than the price", () => {
    expect(unitDiscountCents(350, { kind: "percent", value: 20 })).toBe(70);
    expect(unitDiscountCents(333, { kind: "percent", value: 10 })).toBe(33);
    expect(unitDiscountCents(250, { kind: "amount", value: 50 })).toBe(50);
    expect(unitDiscountCents(40, { kind: "amount", value: 50 })).toBe(40);
  });

  it("puts the floor at cost plus the margin percentage, rounded up to the cent", () => {
    expect(marginFloorCents(100, 30)).toBe(130);
    expect(marginFloorCents(101, 30)).toBe(132);
    expect(marginFloorCents(100, 0)).toBe(100);
    expect(marginFloorCents(0, 500)).toBe(0);
  });

  it("keeps a discount exactly at the floor and refuses one a cent below", () => {
    // 200 - 70 = 130 = 100 + 30%.
    expect(keepsMargin(200, 100, { kind: "amount", value: 70 }, 30)).toBe(true);
    expect(keepsMargin(200, 100, { kind: "amount", value: 71 }, 30)).toBe(false);
  });

  it("runs from its start minute up to, not including, its end minute on its weekdays", () => {
    expect(runsAt(quiet, 1, 15 * 60)).toBe(true);
    expect(runsAt(quiet, 3, 17 * 60 - 1)).toBe(true);
    expect(runsAt(quiet, 3, 17 * 60)).toBe(false);
    expect(runsAt(quiet, 4, 16 * 60)).toBe(false);
  });

  it("picks the largest discount among the campaigns that run, include the item and keep its margin", () => {
    const bigger = { ...quiet, discount: { kind: "amount" as const, value: 100 } };
    const belowFloor = { ...quiet, discount: { kind: "percent" as const, value: 90 } };
    const otherItem = { ...quiet, orderTypeIds: ["cake"], discount: { kind: "percent" as const, value: 50 } };
    const latte = { orderTypeId: "latte", priceCents: 400, costCents: 100 };
    expect(bestCampaign([quiet, bigger, belowFloor, otherItem], latte, 2, 16 * 60)).toEqual({ campaign: bigger, unitDiscountCents: 100 });
    expect(bestCampaign([quiet], latte, 2, 18 * 60)).toBeNull();
    expect(bestCampaign([quiet], { ...latte, costCents: 300 }, 2, 16 * 60)).toBeNull();
  });
});
