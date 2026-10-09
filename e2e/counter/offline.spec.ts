import { expect, test } from "@playwright/test";

test("opens offline once the service worker has kept the app (AC 29)", async ({ page, context }) => {
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Cafe Loyalty Counter" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(/^Offline/);
  await page.goto("/pair");
  await expect(page.getByRole("heading", { name: "Pair this phone" })).toBeVisible();
});
