import { expect, test } from "@playwright/test";
import { UNAUTHENTICATED, mockApi, reply } from "./api-mock.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(401, UNAUTHENTICATED) });
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
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
