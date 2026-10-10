import { readFile } from "node:fs/promises";
import { LOGO_SVG_PATH } from "@cafe-loyalty/ui";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { renderSVG } from "uqr";
import { CUSTOMER_CSP, FONT_FILES, FONT_PATH, LOGO_PATH, type Lang } from "../../apps/server/src/customer-html.js";
import { cardView, deletedView, errorView, joinView, recoverView, restoreView, restoredView, type CardView } from "../../apps/server/src/customer-views.js";
import { GOOGLE_WALLET_BADGES } from "../../apps/server/src/google-pass.js";

/**
 * Screenshots of every customer page at three widths, attached to the report for review (Step 13b). The pages are the
 * server's own views rendered with fake data, served with the customer pages' CSP, fonts and logo, so a font or image
 * the policy blocks shows up here too. No pixels are compared: font rendering differs between machines.
 */
const ORIGIN = "https://card.example.test";

const QR = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG("fake-card-qr-for-screenshots-only", { border: 4 }))}`;
const PROGRAM = { en: { stampsRequired: 9, reward: "Free coffee" }, ar: { stampsRequired: 9, reward: "قهوة مجانية" } } as const;
const OFFER = {
  en: { headline: "Quiet afternoons · 20% off", details: "Monday to Thursday, 15:00–17:00, on Latte and Espresso." },
  ar: { headline: "عصرية هادئة · خصم 20%", details: "من الاثنين إلى الخميس، 15:00–17:00، على اللاتيه والإسبريسو." },
} as const;

const card = (lang: Lang, overrides: Partial<CardView> = {}): string =>
  cardView(lang, {
    path: "/c/fake",
    cafeName: lang === "ar" ? "مقهى النجار" : "Café Najjar",
    stamps: 4,
    program: PROGRAM[lang],
    qr: QR,
    offer: OFFER[lang],
    wallet: { kind: "google", href: "/c/fake/google-pass", badge: GOOGLE_WALLET_BADGES[lang] },
    email: null,
    offersOptedIn: true,
    notice: undefined,
    errors: {},
    otherLangHref: "/c/fake?lang=ar",
    ...overrides,
  });

const join = (lang: Lang, errors: { phone?: string; privacy?: string } = {}) =>
  joinView(lang, {
    path: "/join/fake",
    cafeName: lang === "ar" ? "مقهى النجار" : "Café Najjar",
    program: PROGRAM[lang],
    formToken: "fake-form-token",
    values: errors.phone === undefined ? {} : { phone: "70 12" },
    errors,
    otherLangHref: "/join/fake?lang=ar",
  });

const PAGES: readonly [name: string, html: string][] = [
  ["join-en", join("en")],
  ["join-ar", join("ar")],
  ["join-errors-en", join("en", { phone: "Enter a mobile number, such as 70 123 456 or +961 70 123 456.", privacy: "Tick the box to accept the privacy notice." })],
  ["card-en", card("en")],
  ["card-ar", card("ar", { wallet: { kind: "apple", href: "/c/fake/apple-pass" }, stamps: 9, offer: undefined, email: "rana@example.com", notice: "تم الحفظ." })],
  ["card-no-program-en", card("en", { program: undefined, stamps: 2, offer: undefined, wallet: null, offersOptedIn: false })],
  ["recover-en", recoverView("en", false, undefined, "/recover?lang=ar")],
  ["recover-sent-ar", recoverView("ar", true, undefined, "/recover?lang=en")],
  ["restore-en", restoreView("en", "/r/fake", "/r/fake?lang=ar")],
  ["restored-en", restoredView("en", [{ href: "/c/one", label: "Café Najjar" }, { href: "/c/two", label: "Bean There" }])],
  ["deleted-ar", deletedView("ar", "/recover?lang=en")],
  ["error-en", errorView("en", "This card link no longer works. If you restored your card on another phone, use the new link there.", "/c/fake?lang=ar")],
];

/** Serves `html` at the origin's root as the server would, with the customer pages' fonts and logo next to it. */
async function serve(page: Page, html: string): Promise<{ blocked: string[] }> {
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/i.test(message.text())) {
      blocked.push(message.text());
    }
  });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith(FONT_PATH)) {
      const file = FONT_FILES.get(pathname.slice(FONT_PATH.length));
      await (file === undefined
        ? route.fulfill({ status: 404 })
        : route.fulfill({ status: 200, contentType: file.endsWith(".woff2") ? "font/woff2" : "font/woff", body: await readFile(file) }));
    } else if (pathname === LOGO_PATH) {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: await readFile(LOGO_SVG_PATH) });
    } else {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "content-security-policy": CUSTOMER_CSP }, body: html });
    }
  });
  return { blocked };
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

for (const width of [1440, 1024, 390] as const) {
  test.describe(`customer pages at ${String(width)} px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });

    for (const [name, html] of PAGES) {
      test(name, async ({ page }, testInfo) => {
        const { blocked } = await serve(page, html);
        await page.goto(`${ORIGIN}/`);
        // By element: the error page's h1 is an alert.
        await expect(page.locator("h1")).toBeVisible();
        // The self-hosted font loaded under the page's own policy, and nothing was refused.
        expect(await page.evaluate(() => document.fonts.check('16px "IBM Plex Sans Arabic"'))).toBe(true);
        expect(blocked).toEqual([]);
        await capture(page, testInfo, `customer-${name}-${String(width)}`);
      });
    }
  });
}
