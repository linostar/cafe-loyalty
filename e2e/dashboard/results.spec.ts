import { expect, test } from "@playwright/test";
import { SESSION, mockApi, reply } from "./api-mock.js";

test.use({ timezoneId: "UTC" });

// Fake figures for the test only.
const report = (month: string, current: boolean, memberVisits: number) => ({
  month,
  current,
  months: ["2026-10", "2026-09"],
  memberVisits,
  customersWonBack: 6,
  quietHourVisits: 58,
  rewardRedemptions: 21,
  offers: { winBack: { visits: 6, costCents: 540, revenueCents: 2830 }, quietHour: { visits: 58, costCents: 4350, revenueCents: 21460 } },
});

test("shows this month's results so far, and another month picked from the list (AC 38)", async ({ page }) => {
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/results": (route) => {
      const month = new URL(route.request().url()).searchParams.get("month");
      return route.fulfill({ json: month === "2026-09" ? report("2026-09", false, 377) : report("2026-10", true, 412) });
    },
  });
  await page.goto("/");
  // On a phone (the default viewport) Results is one of the setup pages behind More.
  await page.getByRole("navigation").getByRole("button", { name: "More" }).click();
  await page.getByRole("navigation").getByRole("link", { name: "Results" }).click();
  await expect(page.getByRole("heading", { name: "Results", level: 2 })).toBeVisible();
  const picker = page.getByRole("combobox", { name: "Month" });
  await expect(picker).toHaveValue("2026-10");
  await expect(picker.getByRole("option")).toHaveText(["October 2026 (so far)", "September 2026"]);
  await expect(page.getByText("October 2026 so far, still running.", { exact: false })).toBeVisible();
  for (const [value, label] of [
    ["412", "Member visits"],
    ["6", "Customers won back"],
    ["58", "Quiet-hour visits"],
    ["21", "Rewards redeemed"],
  ] as const) {
    await expect(page.getByRole("listitem").filter({ hasText: label })).toContainText(value);
  }
  const offers = page.getByRole("table", { name: "Offers in October 2026" });
  await expect(offers.getByRole("row", { name: "Welcome-back offers 6 $5.40 $28.30" })).toBeVisible();
  await expect(offers.getByRole("row", { name: "Quiet-hour campaigns 58 $43.50 $214.60" })).toBeVisible();

  // selectOption does not focus the picker: as the owner would, it is focused first, and must keep focus as it reloads.
  await picker.focus();
  await picker.selectOption("2026-09");
  await expect(page.getByRole("status")).toHaveText("Showing September 2026.");
  await expect(page.getByText("All of September 2026.", { exact: false })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Member visits" })).toContainText("377");
  await expect(page.getByRole("table", { name: "Offers in September 2026" })).toBeVisible();
  await expect(picker).toBeFocused();
});

test("shows a café without member visits yet only this month, at zero", async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(200, SESSION), "GET /api/results": reply(200, { ...report("2026-10", true, 0), months: ["2026-10"], customersWonBack: 0 }) });
  await page.goto("/results");
  await expect(page.getByRole("combobox", { name: "Month" }).getByRole("option")).toHaveText(["October 2026 (so far)"]);
  await expect(page.getByRole("listitem").filter({ hasText: "Member visits" })).toContainText("0");
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
