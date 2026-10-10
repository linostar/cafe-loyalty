import { pbkdf2Sync, randomBytes } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectFocusNeverHidden } from "../focus.js";
import { mockApi, reply } from "../dashboard/api-mock.js";
import { CAMERA_CAFE_ID } from "./camera.js";

/**
 * Screenshots of the counter's screens at three widths, with fake data, attached to the report for review (Step 13b).
 * They assert no pixels (font rendering differs between machines); on a landscape tablet they check that the order's
 * total and its Record visit button stay in view (AC 10 of the plan).
 */
test.use({ serviceWorkers: "block", timezoneId: "Asia/Beirut" });

const PAIRED = {
  deviceId: "7e57d3c1-0000-4000-8000-000000000001",
  keyId: "7e57d3c1-0000-4000-8000-000000000002",
  deviceName: "Front counter",
  cafe: { id: CAMERA_CAFE_ID, name: "Café Najjar" },
  // Fake test token shaped like a real one; never a real credential.
  accessToken: "e2eFakeDeviceToken_0123456789abcdefghijklm",
  accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
};
const salt = randomBytes(16);
const barista = (index: number, name: string) => ({
  id: `2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d${String(index).padStart(2, "0")}`,
  name,
  pinSalt: salt.toString("base64url"),
  pinHash: pbkdf2Sync("482913", salt, 1000, 32, "sha256").toString("base64url"),
  pinIterations: 1000,
});
const STAFF = [barista(1, "Rami"), barista(2, "Maya"), barista(3, "Karim"), barista(4, "Lina")];
const orderType = (index: number, nameEn: string, nameAr: string, priceCents: number, costCents: number, stampsEarned = 1) => ({
  id: `3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e${String(index).padStart(2, "0")}`,
  nameEn,
  nameAr,
  priceCents,
  costCents,
  stampsEarned,
});
const MENU = [
  orderType(1, "Espresso", "إسبريسو", 250, 70),
  orderType(2, "Latte", "لاتيه", 350, 110),
  orderType(3, "Cappuccino", "كابتشينو", 350, 110),
  orderType(4, "Iced coffee", "قهوة مثلجة", 400, 120),
  orderType(5, "Croissant", "كرواسان", 200, 80, 0),
  orderType(6, "Cheesecake", "تشيز كيك", 450, 150, 0),
];
const CATALOG = {
  catalogVersion: 4,
  timeZone: "Asia/Beirut",
  campaigns: [
    {
      id: "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c",
      nameAr: "عرض",
      nameEn: "Quiet afternoons",
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      startsMinute: 0,
      endsMinute: 1440,
      discount: { kind: "percent", value: 20 },
      minMarginPercent: 30,
      orderTypeIds: [MENU[1]?.id],
    },
  ],
  winBackOffers: [] as unknown[],
  orderTypes: MENU,
  program: { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" },
};

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
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

async function mockCounter(page: Page): Promise<void> {
  await mockApi(page, {
    "POST /api/device/pair": reply(201, PAIRED),
    "GET /api/device/staff": reply(200, { staff: STAFF }),
    "GET /api/device/catalog": reply(200, CATALOG),
    "POST /api/device/sync": reply(200, { results: [] }),
  });
}

/** Pairs the counter and opens Rami's PIN screen, capturing each screen on the way when `shoot` is set. */
async function toPin(page: Page, testInfo: TestInfo, width: number, shoot: boolean): Promise<void> {
  const shot = async (name: string) => {
    if (shoot) {
      await capture(page, testInfo, `counter-${name}-${String(width)}`);
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
    test.use({ viewport: { width, height }, isMobile: width === 390, hasTouch: width !== 1440 });

    test("pairing, who is working, PIN, an order, and offline", async ({ page, context }, testInfo) => {
      await toPin(page, testInfo, width, true);
      await page.getByLabel("PIN", { exact: true }).fill("482913");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("heading", { name: "New visit" })).toBeVisible();
      await page.getByRole("button", { name: "One more Latte" }).click();
      await page.getByRole("button", { name: "One more Latte" }).click();
      await page.getByRole("button", { name: "One more Croissant" }).click();
      await page.getByLabel("Or the customer's mobile number").fill("70 123 456");
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
      }
      await capture(page, testInfo, `counter-order-${String(width)}`);
      await context.setOffline(true);
      await expect(page.getByRole("status").first()).toHaveText(/^Offline/);
      await capture(page, testInfo, `counter-offline-${String(width)}`);
      // Offline, the header is at its tallest (the pills wrap under the brand on narrow screens).
      await expectFocusNeverHidden(page);
    });

    test("a PIN typed wrong", async ({ page }, testInfo) => {
      await toPin(page, testInfo, width, false);
      await page.getByLabel("PIN", { exact: true }).fill("111111");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("alert")).toContainText("Wrong PIN");
      await capture(page, testInfo, `counter-pin-wrong-${String(width)}`);
    });
  });
}
