import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectFocusNeverHidden } from "../focus.js";
import { expectAccessible, mockCounter } from "./fixtures.js";

/**
 * Screenshots of the counter's screens at three widths, with fake data, attached to the report for review (Step 13b).
 * They assert no pixels (font rendering differs between machines); on a landscape tablet they check that the order's
 * total and its Record visit button stay in view (AC 10 of the plan). Each screen is checked for WCAG 2.2 AA with axe,
 * for 44 px touch targets and under forced colours; 320 px is the reflow width of WCAG 1.4.10.
 */

test.use({ serviceWorkers: "block", timezoneId: "Asia/Beirut" });

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
] as const;

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  // From the top, so the sticky order summary is drawn where they belong in the image.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** Pairs the counter and opens Rami's PIN screen, capturing each screen on the way when `shoot` is set. */
async function toPin(page: Page, testInfo: TestInfo, width: number, shoot: boolean): Promise<void> {
  const shot = async (name: string) => {
    if (shoot) {
      await capture(page, testInfo, `counter-${name}-${String(width)}`);
      await expectAccessible(page, "en");
    }
  };
  await mockCounter(page);
  await page.goto("/pair#code=ABCD-1234-EFGH");
  await expect(page.getByRole("heading", { name: "Pair this phone" })).toBeVisible();
  await shot("pair");
  await page.getByRole("button", { name: "Pair this phone" }).click();
  await expect(page.getByRole("button", { name: "Rami" })).toBeVisible();
  await shot("who");
  await page.getByRole("button", { name: "Rami" }).click();
  await page.getByLabel("PIN", { exact: true }).fill("4829");
  await shot("pin");
}

for (const { width, height } of WIDTHS) {
  test.describe(`at ${String(width)} px`, () => {
    test.use({ viewport: { width, height }, isMobile: width <= 390, hasTouch: width !== 1440 });

    test("pairing, who is working, PIN, an order, and offline", async ({ page, context }, testInfo) => {
      await toPin(page, testInfo, width, true);
      await page.getByLabel("PIN", { exact: true }).fill("482913");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("heading", { name: "New visit" })).toBeVisible();
      await page.getByRole("button", { name: "One more Latte" }).click();
      await page.getByRole("button", { name: "One more Latte" }).click();
      await page.getByRole("button", { name: "One more Croissant" }).click();
      await page.getByLabel("No card? The customer's mobile number").fill("70 123 456");
      await expect(page.getByText("Total $7.60 · 2 stamps")).toBeVisible();
      if (width === 1024 || width === 768) {
        // A tablet, landscape or portrait: the menu lines, the card scan, the total and the button in view without scrolling.
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        for (const line of ["One more Espresso", "One more Cheesecake", "Scan card", "Record visit"]) {
          await expect(page.getByRole("button", { name: line, exact: true })).toBeInViewport();
        }
        await expect(page.getByText("Total $7.60 · 2 stamps")).toBeInViewport();
      } else if (width <= 390) {
        // A phone: the action bar keeps the total, the card scan and the button on screen at the menu's start and its end.
        for (const where of ["start", "end"] as const) {
          await (where === "start"
            ? page.evaluate(() => {
                window.scrollTo(0, 0);
              })
            : page.getByRole("button", { name: "One more Cheesecake" }).scrollIntoViewIfNeeded());
          for (const line of ["Scan card", "Record visit"]) {
            await expect(page.getByRole("button", { name: line, exact: true }), `${line} at the menu's ${where}`).toBeInViewport({ ratio: 1 });
          }
          await expect(page.getByText("Total $7.60 · 2 stamps"), `the total at the menu's ${where}`).toBeInViewport({ ratio: 1 });
        }
      }
      await capture(page, testInfo, `counter-order-${String(width)}`);
      await expectAccessible(page, "en");
      await context.setOffline(true);
      await expect(page.getByRole("status").first()).toHaveText(/^Offline/);
      await capture(page, testInfo, `counter-offline-${String(width)}`);
      await expectAccessible(page, "en");
      // Offline, the status chip is at its widest; on a phone the action bar is at the bottom of the screen.
      await expectFocusNeverHidden(page);
    });

    test("a saved visit with its Undo, a card with its reward ready, and switching barista with an order open", async ({ page }, testInfo) => {
      const check = async (name: string) => {
        await capture(page, testInfo, `counter-${name}-${String(width)}`);
        await expectAccessible(page, "en");
      };
      await toPin(page, testInfo, width, false);
      await page.getByLabel("PIN", { exact: true }).fill("482913");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("button", { name: "One more Latte" }).click();
      await page.getByLabel("No card? The customer's mobile number").fill("70 123 456");
      await expect(page.getByText("Records it for", { exact: false })).toBeVisible();
      await page.getByRole("button", { name: "Record visit" }).click();
      await expect(page.getByRole("button", { name: "Undo the visit" })).toBeVisible();
      if (width >= 1024) {
        // Read from arm's length on a landscape tablet (K12): the menu and the saved visit larger than body text.
        const sizes = await page.evaluate(() =>
          [".menu-item", ".saved", "body"].map((selector) => parseFloat(getComputedStyle(document.querySelector(selector) ?? document.body).fontSize)),
        );
        const [menu = 0, saved = 0, body = 0] = sizes;
        expect(menu, "menu text").toBeGreaterThan(body);
        expect(saved, "saved visit").toBeGreaterThan(menu);
      }
      await check("saved");
      await page.getByRole("button", { name: "Scan card", exact: true }).click();
      await expect(page.locator(".reward-ready").getByText("Reward ready: Free coffee.")).toBeVisible({ timeout: 15_000 });
      await check("reward-ready");
      await page.getByRole("button", { name: "Switch barista" }).click();
      await expect(page.getByRole("button", { name: "Keep the order" })).toBeFocused();
      await check("switch-confirm");
      // With a card scanned, the action bar is at its tallest on a phone: nothing the keyboard reaches hides under it.
      await expectFocusNeverHidden(page);
      await page.getByRole("button", { name: "Keep the order" }).click();
      await page.getByRole("button", { name: "One more Latte" }).click();
      await page.getByRole("button", { name: "Record visit" }).click();
      await expect(page.getByRole("button", { name: "Undo the visit" })).toBeVisible();
      // And with a saved visit's notice and its Undo in it.
      await expectFocusNeverHidden(page);
    });

    test("a PIN typed wrong", async ({ page }, testInfo) => {
      await toPin(page, testInfo, width, false);
      await page.getByLabel("PIN", { exact: true }).fill("111111");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("alert")).toContainText("Wrong PIN");
      await capture(page, testInfo, `counter-pin-wrong-${String(width)}`);
      await expectAccessible(page, "en");
    });
  });
}

/** The counter in Arabic (AC 41): each screen right to left, fitting the width, every control named. */
for (const { width, height } of [WIDTHS[1], WIDTHS[3], WIDTHS[4]]) {
  test.describe(`in Arabic at ${String(width)} px`, () => {
    test.use({ locale: "ar-LB", viewport: { width, height }, isMobile: width <= 390, hasTouch: true });

    test("pairing, who is working, PIN, an order, and offline", async ({ page, context }, testInfo) => {
      const check = async (name: string) => {
        await capture(page, testInfo, `counter-${name}-ar-${String(width)}`);
        await expectAccessible(page, "ar");
      };
      await mockCounter(page);
      await page.goto("/pair#code=ABCD-1234-EFGH");
      await expect(page.getByRole("heading", { name: "اربط هذا الهاتف" })).toBeVisible();
      await check("pair");
      await page.getByRole("button", { name: "اربط هذا الهاتف" }).click();
      await expect(page.getByRole("button", { name: "Rami" })).toBeVisible();
      await check("who");
      await page.getByRole("button", { name: "Rami" }).click();
      // A wrong PIN first, then the right one typed on an Arabic keypad.
      await page.getByLabel("الرمز السري", { exact: true }).fill("١١١١١١");
      await page.getByRole("button", { name: "تسجيل الدخول" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await check("pin-wrong");
      await page.getByLabel("الرمز السري", { exact: true }).fill("٤٨٢٩١٣");
      await check("pin");
      await page.getByRole("button", { name: "تسجيل الدخول" }).click();
      await expect(page.getByRole("heading", { name: "زيارة جديدة" })).toBeVisible();
      await page.getByRole("button", { name: /^زيادة .*لاتيه/ }).click();
      await check("order");
      await context.setOffline(true);
      await expect(page.getByRole("status").first()).not.toHaveText("متصل");
      await check("offline");
      await expectFocusNeverHidden(page);
    });
  });
}
