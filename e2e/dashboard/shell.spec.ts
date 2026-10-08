import { expect, test } from "@playwright/test";

test("shows the heading and build", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Cafe Loyalty Dashboard" })).toBeVisible();
  await expect(page.getByText(/^Build \S+$/)).toBeVisible();
});

test("fits a 360 px phone screen without horizontal scrolling", async ({ page }) => {
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
