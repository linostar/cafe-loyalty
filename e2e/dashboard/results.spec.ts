import { expect, test } from "@playwright/test";
import { SESSION, mockApi, reply } from "./api-mock.js";

test.use({ timezoneId: "UTC" });

const EMPTY_OFFER = { visits: 0, costCents: 0, revenueCents: 0 };

test("shows the first month's results: customers won back, quiet-hour visits, redemptions and offer cost against revenue (AC 38)", async ({ page }) => {
  // Fake figures for the test only.
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/results": reply(200, {
      window: { from: "2026-09-20T08:00:00.000Z", to: "2026-10-20T08:00:00.000Z", complete: false },
      memberVisits: 412,
      customersWonBack: 6,
      quietHourVisits: 58,
      rewardRedemptions: 21,
      offers: { winBack: { visits: 6, costCents: 540, revenueCents: 2830 }, quietHour: { visits: 58, costCents: 4350, revenueCents: 21460 } },
    }),
  });
  await page.goto("/");
  await page.getByRole("navigation").getByRole("link", { name: "Results" }).click();
  await expect(page.getByRole("heading", { name: "First month" })).toBeVisible();
  await expect(page.getByText("So far in your first 30 days, from 20 Sept 2026 to 20 Oct 2026, still running.")).toBeVisible();
  for (const [value, label] of [
    ["412", "Member visits"],
    ["6", "Customers won back"],
    ["58", "Quiet-hour visits"],
    ["21", "Rewards redeemed"],
  ] as const) {
    await expect(page.getByRole("listitem").filter({ hasText: label })).toContainText(value);
  }
  const offers = page.getByRole("table", { name: "Offers in the first month" });
  await expect(offers.getByRole("row", { name: "Win-back offers 6 $5.40 $28.30" })).toBeVisible();
  await expect(offers.getByRole("row", { name: "Quiet-hour campaigns 58 $43.50 $214.60" })).toBeVisible();
});

test("says when the first month has not started", async ({ page }) => {
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/results": reply(200, { window: null, memberVisits: 0, customersWonBack: 0, quietHourVisits: 0, rewardRedemptions: 0, offers: { winBack: EMPTY_OFFER, quietHour: EMPTY_OFFER } }),
  });
  await page.goto("/results");
  await expect(page.getByText("Your first month starts with the first visit recorded with a loyalty card.")).toBeVisible();
});

test("tells the owner when the operator suspended the café (AC 39)", async ({ page }) => {
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, {
      cafe: { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1, minMarginPercent: 0, winBack: { discount: null, cooldownDays: 30 }, googleReviewUrl: null, plan: "suspended" },
      program: null,
      orderTypes: [],
    }),
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your café's plan is suspended" })).toBeVisible();
  await expect(page.getByText("New customers cannot join from your signup QR.")).toBeVisible();
});
