import { pbkdf2Sync, randomBytes } from "node:crypto";
import { syncResult, type SyncResultCode } from "@cafe-loyalty/shared";
import { expect, type Page, type Route } from "@playwright/test";
import { expectEveryControlNamed, expectLanguageAndFit, expectNoAxeViolations, expectTextSpacing, expectTextZoom, expectTouchTargets, expectUsableInForcedColors } from "../a11y.js";
import { mockApi, reply } from "../dashboard/api-mock.js";
import { CAMERA_CAFE_ID } from "./camera.js";

/** Fake counter data for the screens specs: test data only, never a real credential or person. */
export const PAIRED = {
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
export const STAFF = [barista(1, "Rami"), barista(2, "Maya"), barista(3, "Karim"), barista(4, "Lina")];
const orderType = (index: number, nameEn: string, nameAr: string, priceCents: number, costCents: number, stampsEarned = 1) => ({
  id: `3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e${String(index).padStart(2, "0")}`,
  nameEn,
  nameAr,
  priceCents,
  costCents,
  stampsEarned,
});
export const MENU = [
  orderType(1, "Espresso", "إسبريسو", 250, 70),
  orderType(2, "Latte", "لاتيه", 350, 110),
  orderType(3, "Cappuccino", "كابتشينو", 350, 110),
  orderType(4, "Iced coffee", "قهوة مثلجة", 400, 120),
  orderType(5, "Croissant", "كرواسان", 200, 80, 0),
  orderType(6, "Cheesecake", "تشيز كيك", 450, 150, 0),
];
export const CATALOG = {
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

/** The counter's API with every route its screens call answered; `extra` replaces or adds routes. */
export async function mockCounter(page: Page, extra: Parameters<typeof mockApi>[1] = {}): Promise<void> {
  await mockApi(page, {
    "POST /api/device/pair": reply(201, PAIRED),
    "GET /api/device/staff": reply(200, { staff: STAFF }),
    "GET /api/device/catalog": reply(200, CATALOG),
    "POST /api/device/sync": reply(200, { results: [] }),
    "POST /api/device/cards/status": reply(200, { stamps: 9, rewardReady: true }),
    ...extra,
  });
}

/** A sync route answering every event with `code` (as the server would: its status follows from the code). */
export const syncAnswering =
  (code: () => SyncResultCode) =>
  async (route: Route): Promise<void> => {
    const { events } = route.request().postDataJSON() as { events: unknown[] };
    await route.fulfill({ json: { results: events.map((_, index) => syncResult(index, null, code())) } });
  };

/** Pairs the counter and signs Rami in, in English, with the page's clock installed (so tests can move it on). */
export async function signedIn(page: Page, extra: Parameters<typeof mockApi>[1] = {}): Promise<void> {
  await page.clock.install();
  await mockCounter(page, extra);
  await page.goto("/pair#code=ABCD-1234-EFGH");
  await page.getByRole("button", { name: "Pair this phone" }).click();
  await page.getByRole("button", { name: "Rami" }).click();
  await page.getByLabel("PIN", { exact: true }).fill("482913");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "New visit" })).toBeVisible();
}

/**
 * What every counter screen passes: it fits and reads in `lang`'s direction, the header in one row (brand, status chip
 * and language switch side by side, even offline on a phone), and the accessibility checks.
 */
export async function expectAccessible(page: Page, lang: "ar" | "en"): Promise<void> {
  await expectLanguageAndFit(page, lang);
  const rows = await page.evaluate(() =>
    ["header .brand", "header .connection", "header .lang-switch"].map((selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box === undefined ? null : { top: box.top, bottom: box.bottom };
    }),
  );
  expect(rows, "header parts").not.toContain(null);
  const boxes = rows.filter((box) => box !== null);
  expect(Math.max(...boxes.map((box) => box.top)), "header in one row").toBeLessThan(Math.min(...boxes.map((box) => box.bottom)));
  await expectEveryControlNamed(page);
  await expectNoAxeViolations(page);
  await expectTouchTargets(page);
  await expectUsableInForcedColors(page);
  await expectTextSpacing(page, lang);
  await expectTextZoom(page, lang);
}

/**
 * The screen as it is, checked in English, then in Arabic through the header's switch (which keeps the screen's state,
 * so a state reached once is checked in both languages); `arabic` is text the Arabic screen must show.
 */
export async function expectInBothLanguages(page: Page, arabic: string | RegExp): Promise<void> {
  await expectAccessible(page, "en");
  await page.getByRole("button", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByText(arabic).first()).toBeVisible();
  await expectAccessible(page, "ar");
}
