import { PRODUCT_NAME } from "@cafe-loyalty/shared";
import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { expectEveryControlNamed, expectLanguageAndFit, expectNoAxeViolations, expectUsableInForcedColors, shownText } from "../a11y.js";
import { expectFocusNeverHidden } from "../focus.js";
import { FAKE_TOKEN, SESSION, UNAUTHENTICATED, mockApi, reply, visitHours } from "./api-mock.js";

/**
 * Screenshots of every dashboard page at three widths in English and Arabic, with fake data, attached to the report for
 * review (Steps 13b and 16). They assert no pixels: font rendering differs between machines, so a pixel test would only
 * flake. Each screen is checked for its language's direction, for fitting the width, for controls without a name
 * (AC 41), for WCAG 2.2 AA with axe, and under forced colours; every page is checked to reflow at 320 px (WCAG 1.4.10).
 */
test.use({ timezoneId: "UTC" });

const ORDER_TYPES = [
  { id: "7a1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", nameEn: "Espresso", nameAr: "إسبريسو", priceCents: 250, costCents: 70, stampsEarned: 1, active: true },
  { id: "7a1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f02", nameEn: "Latte", nameAr: "لاتيه", priceCents: 350, costCents: 110, stampsEarned: 1, active: true },
  { id: "7a1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f03", nameEn: "Croissant", nameAr: "كرواسان", priceCents: 200, costCents: 80, stampsEarned: 0, active: false },
];

const CAFE = {
  cafe: { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 4, minMarginPercent: 30, winBack: { discount: { kind: "percent", value: 15 }, cooldownDays: 30 } },
  program: { stampsRequired: 9, rewardNameEn: "Free coffee", rewardNameAr: "قهوة مجانية" },
  orderTypes: ORDER_TYPES,
};

const campaign = (id: string, nameEn: string, weekdays: number[], startsMinute: number, endsMinute: number) => ({
  id,
  nameEn,
  nameAr: "عرض",
  weekdays,
  startsMinute,
  endsMinute,
  discount: { kind: "percent", value: 20 },
  orderTypeIds: [ORDER_TYPES[0]?.id, ORDER_TYPES[1]?.id],
  minMarginPercent: 30,
  createdAt: "2026-10-01T08:00:00.000Z",
  endedAt: null,
});

/** A week of member visits: quiet mornings, a lunch and an after-work peak, a busier weekend. */
const WEEK = Array.from({ length: 7 }, (_, weekday) =>
  Array.from({ length: 24 }, (_, hour) => {
    if (hour < 7 || hour > 22) {
      return 0;
    }
    const peak = Math.max(0, 9 - Math.abs(hour - 13) * 2) + Math.max(0, 11 - Math.abs(hour - 18) * 3);
    return Math.round((peak + 2) * (weekday >= 5 ? 1.6 : 1));
  }),
);

const held = (index: number, reason: string) => ({
  id: `5e1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f${String(index).padStart(2, "0")}`,
  type: "visit.recorded",
  deviceName: "Front counter",
  staffName: "Rami",
  reason,
  discountRefused: false,
  occurredAt: `2026-10-08T0${String(index)}:15:00.000Z`,
  receivedAt: "2026-10-08T12:00:00.000Z",
});

const SIGNED_IN = {
  "GET /api/auth/session": reply(200, SESSION),
  "GET /api/cafe/visit-hours": reply(200, visitHours(WEEK)),
  "GET /api/cafe": reply(200, CAFE),
  "GET /api/cafe/join": reply(200, { joinUrl: "https://card.example.test/join/0123456789abcdef0123456789abcdef" }),
  "GET /api/campaigns": reply(200, {
    running: [campaign("8b1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", "Quiet afternoons", [1, 2, 3, 4], 900, 1020)],
    ended: [{ ...campaign("8b1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f02", "Opening week", [1, 2, 3, 4, 5, 6, 7], 0, 1440), endedAt: "2026-10-05T08:00:00.000Z" }],
  }),
  "GET /api/staff": reply(200, {
    staff: [
      { id: "9c1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", name: "Rami", revoked: false, createdAt: "2026-09-01T08:00:00.000Z" },
      { id: "9c1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f02", name: "Maya", revoked: false, createdAt: "2026-09-02T08:00:00.000Z" },
      { id: "9c1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f03", name: "Karim", revoked: true, createdAt: "2026-09-03T08:00:00.000Z" },
    ],
  }),
  "GET /api/devices": reply(200, {
    devices: [
      { id: "ad1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", name: "Front counter", revoked: false, pairedAt: "2026-09-01T08:00:00.000Z", lastSeenAt: "2026-10-09T07:40:00.000Z" },
      { id: "ad1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f02", name: "Old phone", revoked: true, pairedAt: "2026-08-01T08:00:00.000Z", lastSeenAt: "2026-09-20T15:00:00.000Z" },
    ],
    pairingCodes: [{ id: "be1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", deviceName: "Back bar", expiresAt: "2026-10-09T09:00:00.000Z" }],
  }),
  "GET /api/review-queue": reply(200, {
    items: [
      { ...held(1, "device_revoked"), visit: { stamps: 2, totalCents: 850, items: [{ nameEn: "Espresso", nameAr: "إسبريسو", quantity: 2 }, { nameEn: "Latte", nameAr: "لاتيه", quantity: 1 }] } },
      { ...held(2, "campaign_check"), discountRefused: true },
    ],
    nextCursor: null,
  }),
  "GET /api/feedback": reply(200, {
    items: [
      { id: "7a1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", message: "The croissant was cold, but the latte was great.", receivedAt: "2026-10-08T11:30:00.000Z", visitedAt: "2026-10-08T09:00:00.000Z", read: false },
      { id: "7a1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f02", message: "Lovely music this morning.", receivedAt: "2026-10-07T12:10:00.000Z", visitedAt: "2026-10-07T10:00:00.000Z", read: true },
    ],
    unread: 1,
    nextCursor: null,
  }),
  // This month so far, or the month before when picked.
  "GET /api/results": (route: Route) => {
    const month = new URL(route.request().url()).searchParams.get("month") ?? "2026-10";
    return reply(200, {
      month,
      current: month === "2026-10",
      months: ["2026-10", "2026-09"],
      memberVisits: 412,
      customersWonBack: 6,
      quietHourVisits: 58,
      rewardRedemptions: 21,
      offers: { winBack: { visits: 6, costCents: 540, revenueCents: 2830 }, quietHour: { visits: 58, costCents: 4350, revenueCents: 21460 } },
    })(route);
  },
};

/** The operator's admin screen with fake cafés. */
const ADMIN = {
  "GET /api/admin/session": reply(200, { operator: { id: "c01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", email: "operator@example.com" } }),
  "GET /api/admin/cafes": reply(200, {
    cafes: [
      {
        id: SESSION.cafe.id,
        name: SESSION.cafe.name,
        plan: "active",
        createdAt: "2026-09-01T08:00:00.000Z",
        paidCents: 2500,
        payments: [
          { id: "d01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", amountCents: 2500, paidOn: "2026-10-01", method: "whish", reference: "W-1042", recordedAt: "2026-10-01T09:00:00.000Z", voided: null },
          { id: "d01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f02", amountCents: 2500, paidOn: "2026-09-01", method: "cash", reference: null, recordedAt: "2026-09-01T09:00:00.000Z", voided: { at: "2026-09-02T09:00:00.000Z", reason: "Typed the wrong amount" } },
        ],
      },
      { id: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1e", name: "Study Corner", plan: "pilot", createdAt: "2026-09-15T08:00:00.000Z", paidCents: 0, payments: [] },
    ],
  }),
};

const OWNER_PATHS = ["/", "/cafe", "/cafe/print-qr", "/campaigns", "/staff", "/devices", "/review", "/inbox", "/results", "/account"] as const;

/** A new café's Home, in its setup wizard (D1), and a set-up one's with the checklist of what is left (D22). */
const NEW_CAFE = { ...SIGNED_IN, "GET /api/cafe": reply(200, { ...CAFE, cafe: { ...CAFE.cafe, setupFinishedAt: null, signupQrPrintedAt: null } }) };
const CHECKLIST = {
  ...SIGNED_IN,
  "GET /api/cafe": reply(200, { ...CAFE, cafe: { ...CAFE.cafe, setupFinishedAt: "2026-10-01T08:00:00.000Z", signupQrPrintedAt: null }, program: null, orderTypes: [] }),
};
/** The wizard's way on, whatever its label (Next, or Skip this step) and language. */
const nextStep = (page: Page) => page.locator(".setup-wizard .actions button.primary");
const ADMIN_PATHS = ["/admin", `/admin/cafes/${SESSION.cafe.id}`, "/admin/cafes/new", "/admin/password"] as const;
const SIGNED_OUT_PATHS = ["/", `/signup#invite=${FAKE_TOKEN}`, "/forgot-password", `/reset-password#token=${FAKE_TOKEN}`, "/admin"] as const;
const WIDTHS = [1440, 1024, 390] as const;
/** The browser locale that makes the dashboard pick each language (it follows the browser's languages). */
const LANGS = [
  { lang: "en", locale: "en-US" },
  { lang: "ar", locale: "ar-LB" },
] as const;

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  // From the top, so the sticky nav column is drawn where they belong in the image.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

for (const { lang, locale } of LANGS) {
  for (const width of WIDTHS) {
    test.describe(`${lang} at ${String(width)} px`, () => {
      test.use({ locale, viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });
      const suffix = `${lang === "ar" ? "-ar" : ""}-${String(width)}`;

      /** What every screen must do in this language and at this width, after its screenshot. */
      const check = async (page: Page) => {
        await expectLanguageAndFit(page, lang);
        await expectEveryControlNamed(page);
        await expectNoAxeViolations(page);
        await expectUsableInForcedColors(page);
      };

      for (const path of OWNER_PATHS) {
        test(`signed in at ${path}`, async ({ page }, testInfo) => {
          await mockApi(page, SIGNED_IN);
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
          await expect(page.getByRole("status").filter({ hasText: /\S/ })).toHaveCount(0);
          // The window is titled by the page's own heading, in its language (WCAG 2.4.2).
          const heading = ((await page.getByRole("heading", { level: 2 }).first().textContent()) ?? "").trim();
          await expect(page).toHaveTitle(`${heading} · ${PRODUCT_NAME} ${lang === "ar" ? "لوحة التحكم" : "Dashboard"}`);
          await capture(page, testInfo, `dashboard${path === "/" ? "-home" : path.replaceAll("/", "-")}${suffix}`);
          await check(page);
          await expectFocusNeverHidden(page);
        });
      }

      test("setup wizard, every step", async ({ page }, testInfo) => {
        await mockApi(page, NEW_CAFE);
        await page.goto("/");
        for (let step = 1; step <= 5; step += 1) {
          const heading = page.getByRole("heading", { level: 3, name: lang === "ar" ? `الخطوة \u2068${String(step)}\u2069 من \u20685\u2069` : `Step ${String(step)} of 5` });
          await expect(heading).toBeVisible();
          if (step > 1) {
            await expect(heading).toBeFocused();
          }
          await expect(page.getByRole("status").filter({ hasText: /\S/ })).toHaveCount(0);
          await capture(page, testInfo, `dashboard-setup-step-${String(step)}${suffix}`);
          await check(page);
          await expectFocusNeverHidden(page);
          if (step < 5) {
            await nextStep(page).click();
          }
        }
      });

      test("Home with the setup checklist", async ({ page }, testInfo) => {
        await mockApi(page, CHECKLIST);
        await page.goto("/");
        await expect(page.getByRole("region", { name: lang === "ar" ? "أكمل التجهيز" : "Finish setting up" })).toBeVisible();
        await capture(page, testInfo, `dashboard-home-checklist${suffix}`);
        await check(page);
        await expectFocusNeverHidden(page);
      });

      for (const [name, path] of [
        ["admin", ADMIN_PATHS[0]],
        ["admin-cafe", ADMIN_PATHS[1]],
        ["admin-new-cafe", ADMIN_PATHS[2]],
        ["admin-password", ADMIN_PATHS[3]],
      ] as const) {
        test(`operator signed in at ${path}`, async ({ page }, testInfo) => {
          await mockApi(page, ADMIN);
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
          // Titled by the page's heading, as the owner's pages are (WCAG 2.4.2).
          const heading = ((await page.getByRole("heading", { level: 2 }).textContent()) ?? "").trim();
          await expect(page).toHaveTitle(`${heading} · ${PRODUCT_NAME} ${lang === "ar" ? "الإدارة" : "Admin"}`);
          await capture(page, testInfo, `dashboard-${name}${suffix}`);
          await check(page);
          await expectFocusNeverHidden(page);
        });
      }

      test("operator voiding a payment", async ({ page }, testInfo) => {
        await mockApi(page, ADMIN);
        await page.goto(ADMIN_PATHS[1]);
        await page.getByRole("button", { name: /^Void the payment of|^إبطال دفعة/ }).click();
        await expect(page.getByRole("textbox", { name: /^Reason$|^السبب$/ })).toBeFocused();
        await capture(page, testInfo, `dashboard-admin-cafe-voiding${suffix}`);
        await check(page);
        await expectFocusNeverHidden(page);
      });

      test("inbox with its older messages loaded", async ({ page }, testInfo) => {
        await mockApi(page, {
          ...SIGNED_IN,
          "GET /api/feedback": async (route) => {
            const older = new URL(route.request().url()).searchParams.has("cursor");
            await route.fulfill({
              json: older
                ? {
                    items: [{ id: "7a1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f03", message: "Fake older message about the cake.", receivedAt: "2026-10-01T09:45:00.000Z", visitedAt: "2026-10-01T08:00:00.000Z", read: true }],
                    unread: 1,
                    nextCursor: null,
                  }
                : {
                    items: [{ id: "7a1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", message: "The croissant was cold, but the latte was great.", receivedAt: "2026-10-08T11:30:00.000Z", visitedAt: "2026-10-08T09:00:00.000Z", read: false }],
                    unread: 1,
                    nextCursor: "fake-cursor",
                  },
            });
          },
        });
        await page.goto("/inbox");
        await page.getByRole("button", { name: /^Show older messages$|^عرض الرسائل الأقدم$/ }).click();
        await expect(page.getByRole("listitem").filter({ hasText: "Fake older message about the cake." })).toBeFocused();
        await capture(page, testInfo, `dashboard-inbox-older${suffix}`);
        await check(page);
        await expectFocusNeverHidden(page);
      });

      test("campaign started again from an ended one", async ({ page }, testInfo) => {
        await mockApi(page, SIGNED_IN);
        await page.goto("/campaigns");
        await page.getByRole("button", { name: /^Start again Opening week$|^البدء من جديد ⁨عرض⁩$/ }).click();
        await expect(page.getByRole("heading", { level: 3, name: /^New campaign$|^حملة جديدة$/ })).toBeFocused();
        await capture(page, testInfo, `dashboard-campaigns-start-again${suffix}`);
        await check(page);
        await expectFocusNeverHidden(page);
      });

      test("profile menu open", async ({ page }, testInfo) => {
        await mockApi(page, SIGNED_IN);
        await page.goto("/");
        await page.getByRole("button", { name: /^Profile: |^الملف الشخصي: / }).click();
        await expect(page.getByRole("link", { name: /^Account$|^الحساب$/ }).first()).toBeVisible();
        await capture(page, testInfo, `dashboard-profile-menu${suffix}`);
        await expectLanguageAndFit(page, lang);
        await expectEveryControlNamed(page);
        // The open menu lies over the links under it, which axe would measure as covered targets: they are out of
        // reach only until it closes, as with any menu the user opens.
        await expectNoAxeViolations(page, ["target-size"]);
        await expectUsableInForcedColors(page);
      });

      test("Results for an earlier month", async ({ page }, testInfo) => {
        await mockApi(page, SIGNED_IN);
        await page.goto("/results");
        await page.getByRole("combobox", { name: /^Month$|^الشهر$/ }).selectOption("2026-09");
        await expect(page.getByRole("status")).toHaveText(/^(Showing|تُعرض)/);
        await capture(page, testInfo, `dashboard-results-earlier-month${suffix}`);
        await check(page);
        await expectFocusNeverHidden(page);
      });

      test("operator signed out at /admin", async ({ page }, testInfo) => {
        await mockApi(page, { "GET /api/admin/session": reply(401, UNAUTHENTICATED) });
        await page.goto("/admin");
        await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
        await capture(page, testInfo, `dashboard-admin-sign-in${suffix}`);
        await check(page);
      });

      for (const [name, path] of [
        ["sign-in", SIGNED_OUT_PATHS[0]],
        ["signup", SIGNED_OUT_PATHS[1]],
        ["forgot-password", SIGNED_OUT_PATHS[2]],
        ["reset-password", SIGNED_OUT_PATHS[3]],
      ] as const) {
        test(`signed out: ${name}`, async ({ page }, testInfo) => {
          await mockApi(page, { "GET /api/auth/session": reply(401, UNAUTHENTICATED) });
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
          await capture(page, testInfo, `dashboard-${name}${suffix}`);
          await check(page);
        });
      }
    });
  }
}

/** Review's Undo, a shown PIN, an expired pairing code and the Removed groups (D5, D8, D14), in both languages. */
for (const { lang, locale } of LANGS) {
  for (const width of [1440, 390] as const) {
    test.describe(`${lang} at ${String(width)} px: review, staff and devices states`, () => {
      test.use({ locale, viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });
      const suffix = `${lang === "ar" ? "-ar" : ""}-${String(width)}`;
      const check = async (page: Page) => {
        await expectLanguageAndFit(page, lang);
        await expectEveryControlNamed(page);
        await expectNoAxeViolations(page);
        await expectUsableInForcedColors(page);
        await expectFocusNeverHidden(page);
      };

      test("Review: a held visit's order, and an accept waiting with Undo", async ({ page }, testInfo) => {
        await page.clock.install();
        await mockApi(page, SIGNED_IN);
        await page.goto("/review");
        await expect(page.getByText(lang === "ar" ? /الطلب: / : /^Order: 2 × Espresso, 1 × Latte\. Total \$8\.50, for 2 stamps\.$/)).toBeVisible();
        await page.getByRole("button", { name: /^Accept Visit by |^قبول .*Rami/ }).first().click();
        await expect(page.getByRole("button", { name: /^Undo within 10 seconds: accepting |^تراجع خلال 10 ثوانٍ: قبول / })).toBeFocused();
        await capture(page, testInfo, `dashboard-review-undo${suffix}`);
        await check(page);
      });

      test("Staff: a PIN shown, and the Removed group open", async ({ page }, testInfo) => {
        await mockApi(page, SIGNED_IN);
        await page.goto("/staff");
        await page.getByRole("button", { name: /^Show$|^إظهار$/ }).click();
        await expect(page.getByRole("button", { name: /^Show$|^إظهار$/ })).toHaveAttribute("aria-pressed", "true");
        await page.getByText(/^Removed \(1\)$|^المُزالون/).click();
        await expect(page.getByText("Karim")).toBeVisible();
        await capture(page, testInfo, `dashboard-staff-states${suffix}`);
        await check(page);
      });

      test("Devices: an expired pairing code, and the Removed group open", async ({ page }, testInfo) => {
        // The page's clock, not the test runner's: the code expires on the page's time.
        const now = new Date("2026-10-09T08:00:00.000Z");
        await page.clock.install({ time: now });
        await mockApi(page, {
          ...SIGNED_IN,
          "POST /api/devices/pairing-codes": async (route) => {
            await route.fulfill({
              status: 201,
              json: {
                id: "be1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f02",
                deviceName: "Back bar",
                code: "ABCD-EFGH-JKMN",
                pairingUrl: "https://counter.example.test/pair#code=ABCDEFGHJKMN",
                expiresAt: new Date(now.getTime() + 5000).toISOString(),
              },
            });
          },
        });
        await page.goto("/devices");
        await page.getByLabel(/^Phone name$|^اسم الهاتف$/).fill("Back bar");
        await page.getByRole("button", { name: /^Create pairing code$|^إنشاء رمز ربط$/ }).click();
        await page.clock.fastForward(6000);
        await expect(page.getByRole("button", { name: /^New code$|^رمز جديد$/ })).toBeVisible();
        await page.getByText(/^Removed \(1\)$|^المُزالة/).click();
        await expect(page.getByText("Old phone")).toBeVisible();
        // The page says once that the code expired.
        await expect(page.getByRole("status").filter({ hasText: /\S/ })).toHaveCount(1);
        await capture(page, testInfo, `dashboard-devices-states${suffix}`);
        await check(page);
      });
    });
  }
}

/** The Café page's sections, the Review page's short labels and the admin café page's layout (redesign AC 8, 9, 10), in both languages. */
const LAYOUT_TEXT = {
  en: { sections: "Sections of this page", names: ["Name", "Program", "Menu", "Offers and welcome-back", "Signup and reviews"], accept: "Accept", discard: "Discard" },
  ar: { sections: "أقسام هذه الصفحة", names: ["الاسم", "البرنامج", "القائمة", "العروض وعرض العودة", "التسجيل والتقييمات"], accept: "قبول", discard: "إهمال" },
} as const;

for (const { lang, locale } of LANGS) {
  for (const width of [1440, 390] as const) {
    test.describe(`${lang} at ${String(width)} px: page layout`, () => {
      test.use({ locale, viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });
      const text = LAYOUT_TEXT[lang];

      test("the Café page's sections are listed at its top, each card full width and stacked, fields at a readable width", async ({ page }) => {
        await mockApi(page, SIGNED_IN);
        await page.goto("/cafe");
        const links = page.getByRole("navigation", { name: text.sections }).getByRole("link");
        await expect(links).toHaveText([...text.names]);
        for (const [index, name] of text.names.entries()) {
          // Found by the link's target; no section shares its name with the page's own region, Café.
          const section = page.locator(`section${(await links.nth(index).getAttribute("href")) ?? ""}`);
          await expect(section).toHaveRole("region");
          await expect(section).toHaveAccessibleName(name);
          // Every card takes the section's width, each below the one before.
          const boxes = await section.locator(".stack > *").evaluateAll((cards) =>
            cards.map((card) => {
              const { width, top, bottom } = card.getBoundingClientRect();
              return { width, top, bottom };
            }),
          );
          const stack = await section.locator(".stack").evaluate((element) => element.getBoundingClientRect().width);
          expect(boxes.length).toBeGreaterThan(0);
          for (const [at, box] of boxes.entries()) {
            expect(Math.abs(box.width - stack)).toBeLessThanOrEqual(1);
            expect(box.top).toBeGreaterThanOrEqual(at === 0 ? 0 : (boxes[at - 1]?.bottom ?? 0));
          }
        }
        // Fields stay at most the narrow content width (30rem), however wide the card.
        const widest = await page.locator(".settings-section input:not([type='radio'], [type='checkbox'])").evaluateAll((inputs) => Math.max(...inputs.map((input) => input.getBoundingClientRect().width)));
        expect(widest).toBeLessThanOrEqual(480);
        // A link in the list takes the page to its section.
        await links.nth(2).click();
        await expect(page).toHaveURL(/#menu$/);
        await expect(page.getByRole("heading", { level: 3, name: text.names[2], exact: true })).toBeInViewport();
        // The café's name is in the first section, Name, and only the page's own region is named Café.
        await expect(page.locator("section#cafe").getByRole("form", { name: lang === "ar" ? "اسم المقهى" : "Café name" })).toBeVisible();
        await expect(page.getByRole("region", { name: lang === "ar" ? "المقهى" : "Café", exact: true })).toHaveCount(1);
      });

      test("Review shows short labels, and the buttons' names still say which item", async ({ page }) => {
        await mockApi(page, SIGNED_IN);
        await page.goto("/review");
        for (const [label, shown] of [
          [/^Accept Visit by |^قبول .*Rami/, text.accept],
          [/^Discard Visit by |^إهمال .*Rami/, text.discard],
        ] as const) {
          const buttons = page.getByRole("button", { name: label });
          await expect(buttons).toHaveCount(2);
          for (const button of await buttons.all()) {
            expect(await shownText(button)).toBe(shown);
          }
        }
      });

      test("the admin café page is centred, its payments caption starts with its table, and a disabled Save plan says why", async ({ page }) => {
        await mockApi(page, ADMIN);
        await page.goto(ADMIN_PATHS[1]);
        await expect(page.getByRole("table")).toBeVisible();
        const main =await page.getByRole("main").evaluate((element) => {
          const box = element.getBoundingClientRect();
          return { start: box.left, end: document.documentElement.clientWidth - box.right };
        });
        expect(Math.abs(main.start - main.end)).toBeLessThanOrEqual(1);
        // The caption's text begins where the first column's does, at the table's start in either direction.
        const edges = await page.getByRole("table").evaluate((table, rtl) => {
          const textEdge = (element: Element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const box = range.getBoundingClientRect();
            return rtl ? box.right : box.left;
          };
          const caption = table.querySelector("caption");
          const header = table.querySelector("th");
          return caption === null || header === null ? null : { caption: textEdge(caption), header: textEdge(header) };
        }, lang === "ar");
        expect(edges).not.toBeNull();
        expect(Math.abs((edges?.caption ?? 0) - (edges?.header ?? 1000))).toBeLessThanOrEqual(1);
        await expect(page.getByRole("button", { name: /^Save plan|^حفظ الخطة/ })).toHaveAccessibleDescription(lang === "ar" ? "اختر خطة أخرى لحفظها." : "Choose another plan to save.");
      });
    });
  }
}

/** Every page at 320 CSS px, the width WCAG 1.4.10 asks content to reflow to without scrolling sideways (a 1280 px window at 400%). */
for (const { lang, locale } of LANGS) {
  test.describe(`${lang} at 320 px`, () => {
    test.use({ locale, viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });

    test("every page reflows", async ({ page }) => {
      for (const [mock, paths] of [
        [SIGNED_IN, OWNER_PATHS],
        [ADMIN, ADMIN_PATHS],
      ] as const) {
        await mockApi(page, mock);
        for (const path of paths) {
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
          await expectLanguageAndFit(page, lang);
        }
        await page.unrouteAll();
      }
      await mockApi(page, { "GET /api/auth/session": reply(401, UNAUTHENTICATED), "GET /api/admin/session": reply(401, UNAUTHENTICATED) });
      for (const path of SIGNED_OUT_PATHS) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
        await expectLanguageAndFit(page, lang);
      }
    });

    test("every step of the setup wizard, and Home's checklist, reflow", async ({ page }) => {
      await mockApi(page, NEW_CAFE);
      await page.goto("/");
      for (let step = 1; step <= 5; step += 1) {
        await expect(page.locator("#setup-step-title")).toContainText(String(step));
        await expectLanguageAndFit(page, lang);
        if (step < 5) {
          await nextStep(page).click();
        }
      }
      await page.unrouteAll();
      await mockApi(page, CHECKLIST);
      await page.goto("/");
      await expect(page.locator("#setup-checklist-title")).toBeVisible();
      await expectLanguageAndFit(page, lang);
    });

    test("the open void form reflows", async ({ page }) => {
      await mockApi(page, ADMIN);
      await page.goto(ADMIN_PATHS[1]);
      await page.getByRole("button", { name: /^Void the payment of|^إبطال دفعة/ }).click();
      await expect(page.getByRole("textbox", { name: /^Reason$|^السبب$/ })).toBeFocused();
      await expectLanguageAndFit(page, lang);
    });
  });
}
