import { expect, test } from "@playwright/test";
import { SESSION, UNAUTHENTICATED, mockApi, reply } from "./api-mock.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(401, UNAUTHENTICATED) });
});

const SIGNED_IN = {
  "GET /api/auth/session": reply(200, SESSION),
  "GET /api/cafe": reply(200, { cafe: { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1 }, program: null, orderTypes: [] }),
  "GET /api/staff": reply(200, { staff: [] }),
  "GET /api/devices": reply(200, { devices: [], pairingCodes: [] }),
};

for (const path of ["/", "/cafe", "/staff", "/devices", "/account"]) {
  test(`fits a 360 px phone screen when signed in at ${path}`, async ({ page }) => {
    await page.unrouteAll();
    await mockApi(page, SIGNED_IN);
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("shows the heading and build", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Cafe Loyalty Dashboard" })).toBeVisible();
  await expect(page.getByText(/^Build \S+$/)).toBeVisible();
});

for (const path of ["/", "/signup#invite=x", "/forgot-password", "/reset-password#token=x"]) {
  test(`fits a 360 px phone screen without horizontal scrolling at ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
