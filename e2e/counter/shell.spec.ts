import { PRODUCT_NAME } from "@cafe-loyalty/shared";
import { expect, test } from "@playwright/test";
import { cspViolations } from "../csp.js";

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

test("keeps online and offline apart by shape under forced colours", async ({ page, context }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Online");
  // The dot is filled in the theme's text colour online, a ring offline; the chip keeps an outline.
  const dot = () =>
    page.locator(".connection").evaluate((chip) => ({ fill: getComputedStyle(chip, "::before").backgroundColor, outline: getComputedStyle(chip).borderTopStyle }));
  // A fill with no alpha (whatever colour the theme reports for it) is no fill.
  const transparent = /^rgba\(.*, 0\)$/;
  const online = await dot();
  expect(online.outline).toBe("solid");
  expect(online.fill).not.toMatch(transparent);
  await context.setOffline(true);
  await expect(page.getByRole("status")).toHaveText(/^Offline/);
  expect((await dot()).fill).toMatch(transparent);
});

test("fits a 360 px phone screen without horizontal scrolling", async ({ page }) => {
  await page.goto("/");
  // Against the screen's width, not innerWidth: a mobile browser widens its layout viewport to fit content that overflows.
  const screenWidth = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate((width) => document.documentElement.scrollWidth - width, screenWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("runs within its Content-Security-Policy in both languages", async ({ page }) => {
  const refused = cspViolations(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: `${PRODUCT_NAME} Counter` })).toBeVisible();
  await page.getByRole("button", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  expect(refused).toEqual([]);
});
