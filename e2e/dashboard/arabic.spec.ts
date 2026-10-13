import { expect, test, type Route } from "@playwright/test";
import { expectEveryControlNamed, expectLanguageAndFit } from "../a11y.js";
import { FAKE_TOKEN, SESSION, UNAUTHENTICATED, mockApi, reply, visitHours } from "./api-mock.js";

/**
 * The dashboard in Arabic on a 360 px phone (AC 41): every screen right to left, fitting, every control named, and its
 * notices and the server's refusals in Arabic (AC 42).
 */
test.use({ locale: "ar-LB" });

const ESPRESSO = { id: "3d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f41", nameAr: "إسبريسو", nameEn: "Espresso", priceCents: 250, costCents: 70, stampsEarned: 1, active: true };
const LATTE = { id: "4e2d2b63-8d66-4b1f-8b6f-1e5d2c3b4a52", nameAr: "لاتيه", nameEn: "Latte", priceCents: 300, costCents: 200, stampsEarned: 1, active: true };
const cafe = (plan: "pilot" | "suspended") => ({
  cafe: { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1, minMarginPercent: 30, winBack: { discount: null, cooldownDays: 30 }, googleReviewUrl: null, plan },
  program: { stampsRequired: 9, rewardNameEn: "Free coffee", rewardNameAr: "قهوة مجانية" },
  orderTypes: [ESPRESSO, LATTE],
});

const SIGNED_IN = {
  "GET /api/auth/session": reply(200, SESSION),
  "GET /api/cafe": reply(200, cafe("pilot")),
  "GET /api/cafe/visit-hours": reply(200, visitHours(Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, hour) => 100 + hour)))),
  "GET /api/cafe/join": reply(200, { joinUrl: "https://card.example.test/join/0123456789abcdef0123456789abcdef" }),
  "GET /api/campaigns": reply(200, { running: [], ended: [] }),
  "GET /api/staff": reply(200, { staff: [{ id: "9c1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", name: "Rami", revoked: false, createdAt: "2026-09-01T08:00:00.000Z" }] }),
  "GET /api/devices": reply(200, {
    devices: [{ id: "ad1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", name: "Front counter", revoked: false, pairedAt: "2026-09-01T08:00:00.000Z", lastSeenAt: "2026-10-09T07:40:00.000Z" }],
    pairingCodes: [],
  }),
  "GET /api/review-queue": reply(200, { items: [], nextCursor: null }),
  "GET /api/feedback": reply(200, {
    items: [{ id: "7a1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", message: "كانت القهوة رائعة.", receivedAt: "2026-10-08T11:30:00.000Z", visitedAt: "2026-10-08T09:00:00.000Z", read: false }],
    unread: 1,
    more: false,
  }),
  "GET /api/results": reply(200, {
    window: { from: "2026-09-20T08:00:00.000Z", to: "2026-10-20T08:00:00.000Z", complete: true },
    memberVisits: 99999,
    customersWonBack: 9999,
    quietHourVisits: 9999,
    rewardRedemptions: 9999,
    offers: { winBack: { visits: 9999, costCents: 99999999, revenueCents: 99999999 }, quietHour: { visits: 9999, costCents: 99999999, revenueCents: 99999999 } },
  }),
};

for (const path of ["/", "/cafe", "/campaigns", "/staff", "/devices", "/review", "/inbox", "/results", "/account"]) {
  test(`works in Arabic at ${path}`, async ({ page }) => {
    await mockApi(page, SIGNED_IN);
    await page.goto(path);
    await expect(page.getByRole("navigation", { name: "لوحة التحكم" }).getByRole("link", { name: "الرئيسية" })).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expectLanguageAndFit(page, "ar");
    await expectEveryControlNamed(page);
  });
}

for (const path of ["/", `/signup#invite=${FAKE_TOKEN}`, "/forgot-password", `/reset-password#token=${FAKE_TOKEN}`, "/admin"]) {
  test(`works in Arabic signed out at ${path}`, async ({ page }) => {
    await mockApi(page, { "GET /api/auth/session": reply(401, UNAUTHENTICATED), "GET /api/admin/session": reply(401, UNAUTHENTICATED) });
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await expectLanguageAndFit(page, "ar");
    await expectEveryControlNamed(page);
  });
}

for (const path of ["/admin", `/admin/cafes/${SESSION.cafe.id}`, "/admin/cafes/new", "/admin/password"]) {
  test(`works in Arabic on the operator's admin screen at ${path}`, async ({ page }) => {
    await mockApi(page, {
      "GET /api/admin/session": reply(200, { operator: { id: "c01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", email: "operator@example.com" } }),
      "GET /api/admin/cafes": reply(200, {
        cafes: [
          {
            id: SESSION.cafe.id,
            name: SESSION.cafe.name,
            plan: "suspended",
            createdAt: "2026-09-01T08:00:00.000Z",
            paidCents: 99999999,
            payments: [{ id: "d01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", amountCents: 99999999, paidOn: "2026-10-01", method: "bank_transfer", reference: "R".repeat(100), recordedAt: "2026-10-01T09:00:00.000Z" }],
          },
        ],
      }),
    });
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await page.getByRole("button", { name: "الملف الشخصي: operator@example.com" }).click();
    await expect(page.getByRole("link", { name: "تغيير كلمة المرور" })).toBeVisible();
    await expectLanguageAndFit(page, "ar");
    await expectEveryControlNamed(page);
  });
}

test("shows the suspended plan and failing wallet updates in Arabic on the home page", async ({ page }) => {
  await mockApi(page, {
    ...SIGNED_IN,
    "GET /api/cafe": reply(200, cafe("suspended")),
    "GET /api/cafe/wallet-deliveries": reply(200, { failing: [{ wallet: "google", passes: 2, lastFailedAt: "2026-10-09T08:00:00.000Z", lastError: "google_503_UNAVAILABLE" }] }),
  });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "خطة مقهاك موقوفة" })).toBeVisible();
  const wallet = page.getByRole("region", { name: "تحديثات بطاقات المحفظة تفشل" });
  await expect(wallet).toContainText("محفظة Google");
  await expect(wallet).toContainText("بطاقتان");
  await expect(wallet).toContainText("google_503_UNAVAILABLE");
  await expectLanguageAndFit(page, "ar");
});

test("translates each order type the server refuses on its own", async ({ page }) => {
  await mockApi(page, {
    ...SIGNED_IN,
    "POST /api/campaigns": async (route: Route) => {
      await route.fulfill({
        status: 400,
        json: {
          code: "VALIDATION_FAILED",
          message: "This discount takes some order types below your minimum margin. Lower the discount, or leave those order types out.",
          retryable: false,
          details: [
            { path: "orderTypeIds", issue: "Espresso would sell for $2.00, below its floor of $2.10 (cost $0.70 plus 200%)." },
            { path: "orderTypeIds", issue: "Latte would sell for $2.50, below its floor of $6.00 (cost $2.00 plus 200%)." },
          ],
        },
      });
    },
  });
  await page.goto("/campaigns");
  const form = page.getByRole("form", { name: "حملة جديدة" });
  await form.getByLabel("الاسم (بالإنكليزية)").fill("Late evenings");
  await form.getByLabel("الاسم (بالعربية)").fill("سهرة");
  await form.getByRole("checkbox").first().check();
  await form.getByRole("textbox", { name: "خصم بنسبة مئوية" }).fill("10");
  await form.getByRole("checkbox", { name: /إسبريسو/ }).check();
  await form.getByRole("button", { name: "بدء الحملة" }).click();
  await expect(page.getByRole("alert")).toContainText("الحد الأدنى لهامش ربحك");
  const types = form.getByRole("group", { name: "أنواع الطلبات" });
  await expect(types).toHaveAccessibleDescription(/سيُباع ⁨Espresso⁩.*سيُباع ⁨Latte⁩/);
  await expect(types).not.toHaveAccessibleDescription(/would sell/);
});

test("switches to English and keeps the choice after a reload", async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(401, UNAUTHENTICATED) });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expectLanguageAndFit(page, "en");
});

test("sends a barista's PIN typed on an Arabic keypad as the digits the server takes", async ({ page }) => {
  const sent: unknown[] = [];
  const rami = { id: "9c1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f02", name: "Rami", revoked: false, createdAt: "2026-10-10T08:00:00.000Z" };
  await mockApi(page, {
    ...SIGNED_IN,
    "GET /api/staff": reply(200, { staff: [] }),
    "POST /api/staff": async (route: Route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { staff: [rami] } });
    },
  });
  await page.goto("/staff");
  await page.getByLabel("الاسم", { exact: true }).fill("Rami");
  await page.getByLabel("الرمز السري", { exact: true }).fill("٤٨٢٩١٣");
  await page.getByRole("button", { name: "إضافة الباريستا" }).click();
  await expect(page.getByRole("status")).toContainText("تم الحفظ");
  expect(sent).toEqual([{ name: "Rami", pin: "482913" }]);
});
