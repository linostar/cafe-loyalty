import { PRODUCT_NAME } from "@cafe-loyalty/shared";
import { expect, test } from "@playwright/test";
import { SESSION, UNAUTHENTICATED, mockApi, reply, visitHours } from "./api-mock.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(401, UNAUTHENTICATED) });
});

const SIGNED_IN = {
  "GET /api/auth/session": reply(200, SESSION),
  "GET /api/cafe": reply(200, { cafe: { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1, minMarginPercent: 30, winBack: { discount: null, cooldownDays: 30 } }, program: null, orderTypes: [] }),
  "GET /api/campaigns": reply(200, { running: [], ended: [] }),
  "GET /api/cafe/join": reply(200, { joinUrl: "https://card.example.test/join/0123456789abcdef0123456789abcdef" }),
  "GET /api/staff": reply(200, { staff: [] }),
  "GET /api/devices": reply(200, { devices: [], pairingCodes: [] }),
  "GET /api/review-queue": reply(200, { items: [], nextCursor: null }),
  // Every hour busy, with three-digit counts: the widest the busy and quiet hours table gets.
  "GET /api/cafe/visit-hours": reply(200, visitHours(Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, hour) => 100 + hour)))),
};

for (const path of ["/", "/cafe", "/campaigns", "/staff", "/devices", "/review", "/account"]) {
  test(`fits a 360 px phone screen when signed in at ${path}`, async ({ page }) => {
    await page.unrouteAll();
    await mockApi(page, SIGNED_IN);
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
    // Against the screen's width, not innerWidth: a mobile browser widens its layout viewport to fit content that overflows.
    const screenWidth = page.viewportSize()?.width ?? 0;
    const overflow = await page.evaluate((width) => document.documentElement.scrollWidth - width, screenWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("warns on the home page when customers' wallet cards keep failing to update", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, {
    ...SIGNED_IN,
    "GET /api/cafe/wallet-deliveries": reply(200, { failing: [{ wallet: "google", passes: 2, lastFailedAt: "2026-10-09T08:00:00.000Z", lastError: "google_503_UNAVAILABLE" }] }),
  });
  await page.goto("/");
  const warning = page.getByRole("region", { name: "Wallet card updates are failing" });
  await expect(warning).toContainText("Some customers' wallet cards are not showing their latest stamps");
  await expect(warning).toContainText("Google Wallet: 2 cards");
  await expect(warning).toContainText("google_503_UNAVAILABLE");
});

test("shows busy and quiet hours on the home page, the whole week visible on a 360 px phone without scrolling", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, SIGNED_IN);
  await page.goto("/");
  const table = page.getByRole("region", { name: "Busy and quiet hours" }).getByRole("table", { name: "Member visits by hour and weekday" });
  await expect(table.getByRole("row")).toHaveCount(25);
  await expect(table.getByRole("row", { name: /^23:00/ })).toContainText("123");
  const hidden = await table.evaluate((element) => {
    const box = element.parentElement;
    return box === null ? -1 : box.scrollWidth - box.clientWidth;
  });
  expect(hidden).toBe(0);
});

test("shows the heading and build", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: `${PRODUCT_NAME} Dashboard` })).toBeVisible();
  await expect(page.getByText(/^Build \S+$/)).toBeVisible();
});

for (const path of ["/", "/signup#invite=x", "/forgot-password", "/reset-password#token=x"]) {
  test(`fits a 360 px phone screen without horizontal scrolling at ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    // Against the screen's width, not innerWidth: a mobile browser widens its layout viewport to fit content that overflows.
    const screenWidth = page.viewportSize()?.width ?? 0;
    const overflow = await page.evaluate((width) => document.documentElement.scrollWidth - width, screenWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
