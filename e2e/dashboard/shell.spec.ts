import { PRODUCT_NAME } from "@cafe-loyalty/shared";
import { expect, test } from "@playwright/test";
import { cspViolations } from "../csp.js";
import { SESSION, UNAUTHENTICATED, mockApi, reply, visitHours } from "./api-mock.js";

test.beforeEach(async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(401, UNAUTHENTICATED) });
});

const SIGNED_IN = {
  "GET /api/auth/session": reply(200, SESSION),
  "GET /api/cafe": reply(200, { cafe: { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1, minMarginPercent: 30, winBack: { discount: null, cooldownDays: 30 } }, program: null, orderTypes: [] }),
  "GET /api/campaigns": reply(200, { running: [], ended: [] }),
  "GET /api/cafe/join": reply(200, { joinUrl: "https://card.example.test/join/0123456789abcdef0123456789abcdef" }),
  "GET /api/staff": reply(200, { staff: [] }),
  "GET /api/devices": reply(200, { devices: [], pairingCodes: [] }),
  "GET /api/review-queue": reply(200, { items: [], nextCursor: null }),
  // Seven-digit amounts: the widest the offers table gets.
  "GET /api/results": reply(200, {
    month: "2026-10",
    current: true,
    months: ["2026-10", "2026-09"],
    memberVisits: 99999,
    customersWonBack: 9999,
    quietHourVisits: 9999,
    rewardRedemptions: 9999,
    offers: { winBack: { visits: 9999, costCents: 99999999, revenueCents: 99999999 }, quietHour: { visits: 9999, costCents: 99999999, revenueCents: 99999999 } },
  }),
  // Every hour busy, with three-digit counts: the widest the busy and quiet hours table gets.
  "GET /api/cafe/visit-hours": reply(200, visitHours(Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, hour) => 100 + hour)))),
};

for (const path of ["/", "/cafe", "/campaigns", "/staff", "/devices", "/review", "/results", "/account"]) {
  test(`fits a 360 px phone screen when signed in at ${path}, within the Content-Security-Policy`, async ({ page }) => {
    const refused = cspViolations(page);
    await page.unrouteAll();
    await mockApi(page, SIGNED_IN);
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
    // Against the screen's width, not innerWidth: a mobile browser widens its layout viewport to fit content that overflows.
    const screenWidth = page.viewportSize()?.width ?? 0;
    const overflow = await page.evaluate((width) => document.documentElement.scrollWidth - width, screenWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(refused).toEqual([]);
  });
}

test("warns on the home page when customers' wallet cards keep failing to update", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, {
    ...SIGNED_IN,
    "GET /api/cafe/wallet-deliveries": reply(200, { failing: [{ wallet: "google", passes: 2, lastFailedAt: "2026-10-09T08:00:00.000Z", lastError: "google_503_UNAVAILABLE" }] }),
  });
  await page.goto("/");
  const warning = page.getByRole("region", { name: "Wallet card updates are failing" });
  await expect(warning).toContainText("Some customers' wallet cards are not showing their latest stamps");
  await expect(warning).toContainText("Google Wallet: 2 cards");
  await expect(warning).toContainText("google_503_UNAVAILABLE");
});

test("shows busy and quiet hours on the home page, the whole week visible on a 360 px phone without scrolling", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, SIGNED_IN);
  await page.goto("/");
  const table = page.getByRole("region", { name: "Busy and quiet hours" }).getByRole("table", { name: "Member visits by hour and weekday" });
  await expect(table.getByRole("row")).toHaveCount(25);
  await expect(table.getByRole("row", { name: /^23:00/ })).toContainText("123");
  const hidden = await table.evaluate((element) => {
    const box = element.parentElement;
    return box === null ? -1 : box.scrollWidth - box.clientWidth;
  });
  expect(hidden).toBe(0);
});

test("shows the heading and build", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: `${PRODUCT_NAME} Dashboard` })).toBeVisible();
  await expect(page.getByText(/^Build \S+$/)).toBeVisible();
});

test("titles each window by its page, in the page's language (WCAG 2.4.2)", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, SIGNED_IN);
  for (const [path, heading] of [
    ["/staff", "Staff"],
    ["/campaigns", "Campaigns"],
    ["/cafe", "Café"],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveTitle(`${heading} · ${PRODUCT_NAME} Dashboard`);
  }
  await page.getByRole("button", { name: "العربية" }).click();
  await expect(page).toHaveTitle(`المقهى · ${PRODUCT_NAME} لوحة التحكم`);
});

test("leads the keyboard past the top bar and navigation to the page", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, SIGNED_IN);
  await page.goto("/staff");
  await expect(page.getByRole("heading", { level: 2, name: "Staff" })).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await skip.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
});

test("leads the keyboard past the operator's top bar to the page too", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, {
    "GET /api/admin/session": reply(200, { operator: { id: "c01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", email: "operator@example.com" } }),
    "GET /api/admin/cafes": reply(200, { cafes: [] }),
  });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 2, name: "Cafés" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
});

test("loads a failed page again in place, keeping what was typed elsewhere on it", async ({ page }) => {
  await page.unrouteAll();
  let joinLoads = 0;
  await mockApi(page, {
    ...SIGNED_IN,
    "GET /api/cafe/join": async (route) => {
      joinLoads += 1;
      await (joinLoads === 1
        ? route.fulfill({ status: 500, json: { code: "INTERNAL", message: "Something went wrong on this page. Reload it and try again.", retryable: true } })
        : route.fulfill({ json: { joinUrl: "https://card.example.test/join/0123456789abcdef0123456789abcdef" } }));
    },
  });
  await page.goto("/cafe");
  const name = page.getByRole("form", { name: "Café name" }).getByLabel("Name");
  await name.fill("Café Najjar Two");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("img", { name: "QR code customers scan to get a loyalty card" })).toBeVisible();
  // Only the failed section loaded again: the page, and the unsaved name, stayed.
  await expect(name).toHaveValue("Café Najjar Two");
  expect(joinLoads).toBe(2);
});

test("gives the profile button a 44 px target, as the other controls have", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, SIGNED_IN);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/staff");
  const profile = page.getByRole("button", { name: /^Profile: / });
  await expect(profile).toBeVisible();
  const box = await profile.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
});

test("frames each busy level differently under forced colours, as the legend does", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, {
    ...SIGNED_IN,
    // One hour at each level, so every level is drawn.
    "GET /api/cafe/visit-hours": reply(200, visitHours(Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => (day === 0 && hour < 5 ? hour * 25 : 0))))),
  });
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");
  // The table loads after the page: read the frames once it is drawn.
  await expect(page.getByRole("table", { name: "Member visits by hour and weekday" }).locator("td.level-4")).toHaveCount(1);
  const frames = await page.evaluate(() =>
    [1, 2, 3, 4].map((level) => {
      const cell = document.querySelector(`.visit-hours td.level-${String(level)}`);
      const swatch = document.querySelector(`.heat-swatch.level-${String(level)}`);
      const cellStyle = cell === null ? null : getComputedStyle(cell);
      const swatchStyle = swatch === null ? null : getComputedStyle(swatch);
      return {
        cell: cellStyle === null ? "missing" : `${cellStyle.outlineStyle} ${cellStyle.outlineWidth}`,
        swatch: swatchStyle === null ? "missing" : `${swatchStyle.borderTopStyle} ${swatchStyle.borderTopWidth}`,
      };
    }),
  );
  expect(frames).toEqual([
    { cell: "dotted 1px", swatch: "dotted 1px" },
    { cell: "solid 1px", swatch: "solid 1px" },
    { cell: "solid 2px", swatch: "solid 2px" },
    { cell: "solid 4px", swatch: "solid 4px" },
  ]);
});

test("says an unknown address is no page, with the way home, signed in", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, SIGNED_IN);
  await page.goto("/setting");
  await expect(page.getByRole("heading", { level: 2, name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/");
  await expect(page).toHaveTitle(`Page not found · ${PRODUCT_NAME} Dashboard`);
});

test("keeps badges apart from the text around them under forced colours", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, {
    ...SIGNED_IN,
    "GET /api/cafe": reply(200, {
      cafe: { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1, minMarginPercent: 30, winBack: { discount: null, cooldownDays: 30 } },
      program: null,
      orderTypes: [{ id: "7a1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f03", nameEn: "Croissant", nameAr: "كرواسان", priceCents: 200, costCents: 80, stampsEarned: 0, active: false }],
    }),
  });
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/cafe");
  const badge = page.locator(".badge", { hasText: "not on sale" });
  await expect(badge).toBeVisible();
  // The badge's background is gone in a contrast theme; its outline is what marks it.
  expect(await badge.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe("solid");
});

test("says when the connection is gone, and stops saying it when it is back", async ({ page, context }) => {
  await page.unrouteAll();
  await mockApi(page, SIGNED_IN);
  await page.goto("/staff");
  await expect(page.getByRole("heading", { level: 2, name: "Staff" })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole("alert")).toHaveText("You are offline. Pages cannot load and changes cannot be saved until the connection is back.");
  await context.setOffline(false);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

for (const path of ["/", "/signup#invite=x", "/forgot-password", "/reset-password#token=x"]) {
  test(`fits a 360 px phone screen without horizontal scrolling at ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    // Against the screen's width, not innerWidth: a mobile browser widens its layout viewport to fit content that overflows.
    const screenWidth = page.viewportSize()?.width ?? 0;
    const overflow = await page.evaluate((width) => document.documentElement.scrollWidth - width, screenWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("fits a 360 px phone screen on the operator's admin screen", async ({ page }) => {
  await page.unrouteAll();
  // Fake café and payment for the test only, with the longest reference and a large amount.
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
          payments: [{ id: "d01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", amountCents: 99999999, paidOn: "2026-10-01", method: "bank_transfer", reference: "R".repeat(100), recordedAt: "2026-10-01T09:00:00.000Z", voided: null }],
        },
      ],
    }),
  });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Cafés" })).toBeVisible();
  const screenWidth = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate((width) => document.documentElement.scrollWidth - width, screenWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

/** Two held visits and one unread message: what the navigation counts and Home lists (the redesign's AC 7). */
const WAITING_ITEMS = [1, 2].map((index) => ({
  id: `5e1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f0${String(index)}`,
  type: "visit.recorded",
  deviceName: "Front counter",
  staffName: "Rami",
  reason: "device_revoked",
  discountRefused: false,
  occurredAt: `2026-10-08T0${String(index)}:15:00.000Z`,
  receivedAt: "2026-10-08T12:00:00.000Z",
}));

const WAITING = {
  ...SIGNED_IN,
  "GET /api/review-queue": reply(200, { items: WAITING_ITEMS, nextCursor: null }),
  "GET /api/feedback": reply(200, { items: [], unread: 1, nextCursor: null }),
};

test("counts what waits on the Review and Inbox links, and lists it on Home with where to act", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, WAITING);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Dashboard" });
  await expect(nav.getByRole("link", { name: "Review 2 waiting" })).toHaveAttribute("href", "/review");
  await expect(nav.getByRole("link", { name: "Inbox 1 unread" })).toHaveAttribute("href", "/inbox");
  const needs = page.getByRole("region", { name: "Needs you" });
  await expect(needs).toContainText("Visits and actions held for you to check");
  await expect(needs.getByRole("link", { name: "Review them" })).toHaveAttribute("href", "/review");
  await expect(needs.getByRole("link", { name: "Read them" })).toHaveAttribute("href", "/inbox");
  // The tiles that repeated the navigation are gone.
  await expect(page.getByRole("main").getByRole("link", { name: "Campaigns" })).toHaveCount(0);
});

test("says in words when the review queue has more than its first page", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, { ...WAITING, "GET /api/review-queue": reply(200, { items: WAITING_ITEMS, nextCursor: "page-2" }) });
  await page.goto("/");
  const link = page.getByRole("navigation", { name: "Dashboard" }).getByRole("link", { name: "Review 2 or more waiting" });
  await expect(link).toBeVisible();
  await expect(link.locator(".count-badge")).toHaveText("2+");
});

test("updates the counts when the owner decides a held visit and reads a message", async ({ page }) => {
  // The server's state: what is held and what is unread, changed by the owner's decisions.
  let held = WAITING_ITEMS;
  let unread = 1;
  const message = { id: "7a1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", message: "Fake message.", receivedAt: "2026-10-08T11:30:00.000Z", visitedAt: "2026-10-08T08:00:00.000Z" };
  await page.unrouteAll();
  await mockApi(page, {
    ...WAITING,
    "GET /api/review-queue": async (route) => {
      await route.fulfill({ json: { items: held, nextCursor: null } });
    },
    [`POST /api/review-queue/${WAITING_ITEMS[0]?.id ?? ""}/discard`]: async (route) => {
      held = held.slice(1);
      await route.fulfill({ json: { outcome: "OK" } });
    },
    "GET /api/feedback": async (route) => {
      await route.fulfill({ json: { items: [{ ...message, read: unread === 0 }], unread, nextCursor: null } });
    },
    [`POST /api/feedback/${message.id}/read`]: async (route) => {
      unread = 0;
      await route.fulfill({ json: { read: true } });
    },
  });
  const nav = page.getByRole("navigation", { name: "Dashboard" });
  await page.goto("/review");
  await expect(nav.getByRole("link", { name: "Review 2 waiting" })).toBeVisible();
  await page.getByRole("button", { name: /^Discard Visit by Rami/ }).first().click();
  await page.getByRole("button", { name: /^Yes, discard Visit by Rami/ }).click();
  await expect(nav.getByRole("link", { name: "Review 1 waiting" })).toBeVisible();

  await page.goto("/inbox");
  await expect(nav.getByRole("link", { name: "Inbox 1 unread" })).toBeVisible();
  await page.getByRole("button", { name: /^Mark as read/ }).click();
  await expect(nav.getByRole("link", { name: "Inbox", exact: true })).toBeVisible();
});

test("shows this month's figures so far on Home", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, SIGNED_IN);
  await page.goto("/");
  const month = page.getByRole("region", { name: "This month so far" });
  await expect(month.getByRole("listitem").filter({ hasText: "Member visits" })).toContainText("99999");
  await expect(month.getByRole("listitem").filter({ hasText: "Rewards redeemed" })).toContainText("9999");
  await expect(month.getByRole("link", { name: "See all results" })).toHaveAttribute("href", "/results");
});

test("says on Home what it could not load, and still shows the rest", async ({ page }) => {
  const failed = reply(500, { code: "INTERNAL", message: "Something went wrong on our side. Try again in a moment.", retryable: true });
  await page.unrouteAll();
  await mockApi(page, { ...SIGNED_IN, "GET /api/review-queue": failed, "GET /api/feedback": failed, "GET /api/results": failed });
  await page.goto("/");
  const needs = page.getByRole("region", { name: "Needs you" });
  await expect(needs).toContainText("Could not check what is held for review: Something went wrong on our side. Try again in a moment.");
  await expect(needs).toContainText("Could not check your messages: Something went wrong on our side. Try again in a moment.");
  await expect(needs).not.toContainText("Nothing needs you right now.");
  await expect(page.getByRole("region", { name: "This month so far" })).toContainText("Could not load this month's results: Something went wrong on our side. Try again in a moment.");
  await expect(page.getByRole("navigation", { name: "Dashboard" }).getByRole("link", { name: "Review", exact: true })).toBeVisible();
});

test("says on Home when nothing waits", async ({ page }) => {
  await page.unrouteAll();
  await mockApi(page, { ...SIGNED_IN, "GET /api/feedback": reply(200, { items: [], unread: 0, nextCursor: null }) });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Needs you" })).toContainText("Nothing needs you right now.");
  await expect(page.getByRole("navigation", { name: "Dashboard" }).getByRole("link", { name: "Review", exact: true })).toBeVisible();
});

test.describe("Needs you: quiet counter phones (D15)", () => {
  test("lists phones not seen for 2 days, not removed ones, with a link to Devices", async ({ page }) => {
    const phone = (name: string, daysAgo: number, revoked: boolean) => ({
      id: `ad1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f${String(daysAgo).padStart(2, "0")}`,
      name,
      revoked,
      pairedAt: "2026-09-01T08:00:00.000Z",
      lastSeenAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    });
    await page.unrouteAll();
    await mockApi(page, {
      ...SIGNED_IN,
      "GET /api/feedback": reply(200, { items: [], unread: 0, nextCursor: null }),
      "GET /api/devices": reply(200, { devices: [phone("Front counter", 3, false), phone("Back bar", 1, false), phone("Old phone", 9, true), phone("Spare phone", 10, true)], pairingCodes: [] }),
    });
    await page.goto("/");
    const needs = page.getByRole("region", { name: "Needs you" });
    const item = needs.getByRole("listitem").filter({ hasText: "Counter phones not seen for 2 days" });
    await expect(item).toContainText("1 phone");
    await expect(item.getByRole("link", { name: "Check them" })).toHaveAttribute("href", "/devices");
    await expect(needs).not.toContainText("Nothing needs you right now.");
  });
});

test("centres the navigation and the page together on a wide screen", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.unrouteAll();
  await mockApi(page, WAITING);
  await page.goto("/cafe");
  await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
  const [nav, main] = await Promise.all([page.locator("nav.sidenav").boundingBox(), page.locator("main").boundingBox()]);
  expect(nav).not.toBeNull();
  expect(main).not.toBeNull();
  const start = nav?.x ?? 0;
  const end = 1920 - ((main?.x ?? 0) + (main?.width ?? 0));
  expect(start).toBeGreaterThan(100);
  expect(Math.abs(start - end)).toBeLessThanOrEqual(2);
});

for (const { lang, locale, more, cafe } of [
  { lang: "en", locale: "en-US", more: "More", cafe: "Café" },
  { lang: "ar", locale: "ar-LB", more: "المزيد", cafe: "المقهى" },
] as const) {
  test.describe(`on a phone in ${lang}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("keeps the navigation to one row above the page, with the setup pages behind More", async ({ page }) => {
      await page.unrouteAll();
      await mockApi(page, WAITING);
      await page.goto("/");
      const heading = page.getByRole("heading", { level: 2 }).first();
      await expect(heading).toBeVisible();
      const nav = page.getByRole("navigation");
      const parts = await nav.locator(".nav-daily a, .nav-more").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()).map((box) => ({ top: box.top, bottom: box.bottom })));
      expect(parts).toHaveLength(4);
      expect(Math.max(...parts.map((box) => box.top))).toBeLessThan(Math.min(...parts.map((box) => box.bottom)));
      expect((await nav.boundingBox())?.height ?? 0).toBeLessThan(64);
      await expect(nav.getByRole("link", { name: cafe, exact: true })).toBeHidden();
      const button = nav.getByRole("button", { name: more });
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect(nav.getByRole("link", { name: cafe, exact: true })).toBeVisible();
    });
  });
}
