import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectFocusNeverHidden } from "../focus.js";
import { FAKE_TOKEN, SESSION, UNAUTHENTICATED, mockApi, reply, visitHours } from "./api-mock.js";

/**
 * Screenshots of every dashboard page at three widths, with fake data, attached to the report for review (Step 13b).
 * They assert no pixels: font rendering differs between machines, so a pixel test would only flake.
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
  "GET /api/review-queue": reply(200, { items: [held(1, "device_revoked"), { ...held(2, "campaign_check"), discountRefused: true }], nextCursor: null }),
};

const WIDTHS = [1440, 1024, 390] as const;

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  // From the top, so the sticky parts (the nav column, the order summary) are drawn where they belong in the image.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

for (const width of WIDTHS) {
  test.describe(`at ${String(width)} px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });

    for (const path of ["/", "/cafe", "/campaigns", "/staff", "/devices", "/review", "/account"]) {
      test(`signed in at ${path}`, async ({ page }, testInfo) => {
        await mockApi(page, SIGNED_IN);
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
        await expect(page.getByRole("status")).toHaveCount(0);
        await capture(page, testInfo, `dashboard${path === "/" ? "-home" : path.replace("/", "-")}-${String(width)}`);
        await expectFocusNeverHidden(page);
      });
    }

    for (const [name, path] of [
      ["sign-in", "/"],
      ["signup", `/signup#invite=${FAKE_TOKEN}`],
      ["forgot-password", "/forgot-password"],
      ["reset-password", `/reset-password#token=${FAKE_TOKEN}`],
    ] as const) {
      test(`signed out: ${name}`, async ({ page }, testInfo) => {
        await mockApi(page, { "GET /api/auth/session": reply(401, UNAUTHENTICATED) });
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
        await capture(page, testInfo, `dashboard-${name}-${String(width)}`);
      });
    }
  });
}
