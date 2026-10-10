import { PRODUCT_NAME } from "@cafe-loyalty/shared";
import { expect, test } from "@playwright/test";

test("shows the build and tracks connectivity", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: `${PRODUCT_NAME} Counter` })).toBeVisible();
  await expect(page.getByText(/^Build \S+$/)).toBeVisible();

  const status = page.getByRole("status");
  await expect(status).toHaveText("Online");

  await context.setOffline(true);
  await expect(status).toHaveText(/^Offline/);

  await context.setOffline(false);
  await expect(status).toHaveText("Online");
});

test("fits a 360 px phone screen without horizontal scrolling", async ({ page }) => {
  await page.goto("/");
  // Against the screen's width, not innerWidth: a mobile browser widens its layout viewport to fit content that overflows.
  const screenWidth = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate((width) => document.documentElement.scrollWidth - width, screenWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
