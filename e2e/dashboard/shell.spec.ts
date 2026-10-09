import { expect, test } from "@playwright/test";
import { SESSION, UNAUTHENTICATED, mockApi, reply } from "./api-mock.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(401, UNAUTHENTICATED) });
});

const SIGNED_IN = {
  "GET /api/auth/session": reply(200, SESSION),
  "GET /api/cafe": reply(200, { cafe: { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1 }, program: null, orderTypes: [] }),
  "GET /api/cafe/join": reply(200, { joinUrl: "https://card.example.test/join/0123456789abcdef0123456789abcdef" }),
  "GET /api/staff": reply(200, { staff: [] }),
  "GET /api/devices": reply(200, { devices: [], pairingCodes: [] }),
  "GET /api/review-queue": reply(200, { items: [], nextCursor: null }),
};

for (const path of ["/", "/cafe", "/staff", "/devices", "/review", "/account"]) {
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
  const warning = page.getByRole("alert");
  await expect(warning).toContainText("Some customers' wallet cards are not updating");
  await expect(warning).toContainText("Google Wallet: 2 cards");
  await expect(warning).toContainText("google_503_UNAVAILABLE");
});

test("shows the heading and build", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Cafe Loyalty Dashboard" })).toBeVisible();
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
