import { readFile } from "node:fs/promises";
import { LOGO_SVG_PATH } from "@cafe-loyalty/ui";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectEveryControlNamed, expectLanguageAndFit, expectNoAxeViolations, expectTouchTargets, expectUsableInForcedColors } from "../a11y.js";
import { renderSVG } from "uqr";
import { CUSTOMER_CSP, FONT_FILES, FONT_PATH, LOGO_PATH, t, type Lang } from "../../apps/server/src/customer-html.js";
import {
  cardSettingsView,
  cardView,
  deletedView,
  errorView,
  feedbackView,
  joinView,
  recoverView,
  restoreView,
  restoredView,
  type CardSettingsView,
  type CardView,
  type FeedbackView,
} from "../../apps/server/src/customer-views.js";
import { GOOGLE_WALLET_BADGES } from "../../apps/server/src/google-pass.js";

/**
 * Screenshots of every customer page at three widths, attached to the report for review (Step 13b). The pages are the
 * server's own views rendered with fake data, served with the customer pages' CSP, fonts and logo, so a font or image
 * the policy blocks shows up here too. No pixels are compared: font rendering differs between machines. Each page is
 * checked like the counter's (WCAG 2.2 AA with axe, 44 px touch targets, forced colours), down to the 320 px reflow width.
 */
const ORIGIN = "https://card.example.test";

const QR = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG("fake-card-qr-for-screenshots-only", { border: 4 }))}`;
const PROGRAM = { en: { stampsRequired: 9, reward: "Free coffee" }, ar: { stampsRequired: 9, reward: "قهوة مجانية" } } as const;
const OFFER = {
  en: { headline: "Quiet afternoons · 20% off", details: "Monday to Thursday, 15:00–17:00, on Latte and Espresso." },
  ar: { headline: "عصرية هادئة · خصم 20%", details: "من الاثنين إلى الخميس، 15:00–17:00، على اللاتيه والإسبريسو." },
} as const;

/** The language a page's switch leads to. */
const other = (lang: Lang): Lang => (lang === "ar" ? "en" : "ar");

const card = (lang: Lang, overrides: Partial<CardView> = {}): string =>
  cardView(lang, {
    path: "/c/fake",
    cafeName: lang === "ar" ? "مقهى النجار" : "Café Najjar",
    stamps: 4,
    program: PROGRAM[lang],
    qr: QR,
    offer: OFFER[lang],
    wallet: { kind: "google", href: "/c/fake/google-pass", badge: GOOGLE_WALLET_BADGES[lang] },
    otherLangHref: `/c/fake?lang=${other(lang)}`,
    feedbackHref: "/f/fake?lang=en",
    ...overrides,
  });

const settings = (lang: Lang, overrides: Partial<CardSettingsView> = {}): string =>
  cardSettingsView(lang, {
    path: "/c/fake",
    cafeName: lang === "ar" ? "مقهى النجار" : "Café Najjar",
    email: null,
    offersOptedIn: true,
    notice: undefined,
    errors: {},
    otherLangHref: `/c/fake/settings?lang=${other(lang)}`,
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
    otherLangHref: `/join/fake?lang=${other(lang)}`,
  });

const feedback = (lang: Lang, overrides: Partial<FeedbackView> = {}) =>
  feedbackView(lang, {
    path: "/f/fake",
    cafeName: lang === "ar" ? "مقهى النجار" : "Café Najjar",
    reviewUrl: "https://g.page/r/FakeReviewLink/review",
    state: "form",
    message: "",
    error: undefined,
    otherLangHref: `/f/fake?lang=${other(lang)}`,
    ...overrides,
  });

/** Every customer page and state, each rendered in both languages (named `<view>-<lang>`), messages from the real catalog. */
const VIEWS: readonly [name: string, view: (lang: Lang) => string][] = [
  ["join", (lang) => join(lang)],
  ["join-errors", (lang) => join(lang, { phone: t(lang, "phoneInvalid"), privacy: t(lang, "privacyRequired") })],
  ["card", (lang) => card(lang)],
  [
    "card-full",
    (lang) => card(lang, { wallet: { kind: "apple", href: "/c/fake/apple-pass" }, stamps: 9, offer: undefined }),
  ],
  ["card-no-program", (lang) => card(lang, { program: undefined, stamps: 2, offer: undefined, wallet: null, feedbackHref: undefined })],
  ["card-settings", (lang) => settings(lang)],
  ["card-settings-saved", (lang) => settings(lang, { email: "rana@example.com", offersOptedIn: false, notice: t(lang, "saved") })],
  ["card-settings-errors", (lang) => settings(lang, { errors: { email: t(lang, "emailInvalid"), delete: t(lang, "deleteConfirmRequired") } })],
  ["recover", (lang) => recoverView(lang, false, undefined, `/recover?lang=${other(lang)}`)],
  ["recover-sent", (lang) => recoverView(lang, true, undefined, `/recover?lang=${other(lang)}`)],
  ["restore", (lang) => restoreView(lang, "/r/fake", `/r/fake?lang=${other(lang)}`)],
  [
    "restored",
    (lang) =>
      restoredView(lang, [
        { href: "/c/one", label: lang === "ar" ? "مقهى النجار" : "Café Najjar" },
        { href: "/c/two", label: "Bean There" },
      ]),
  ],
  ["deleted", (lang) => deletedView(lang, `/recover?lang=${other(lang)}`)],
  ["feedback", (lang) => feedback(lang)],
  ["feedback-no-review", (lang) => feedback(lang, { reviewUrl: null, message: "", error: t(lang, "feedbackEmpty") })],
  ["feedback-sent", (lang) => feedback(lang, { state: "sent" })],
  ["error", (lang) => errorView(lang, t(lang, "cardGone"), `/c/fake?lang=${other(lang)}`)],
];

const PAGES = VIEWS.flatMap(([name, view]) => (["en", "ar"] as const).map((lang) => ({ name: `${name}-${lang}`, html: view(lang), lang })));

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

for (const width of [1440, 1024, 390, 320] as const) {
  test.describe(`customer pages at ${String(width)} px`, () => {
    test.use({ viewport: { width, height: width <= 390 ? 844 : 900 }, isMobile: width <= 390, hasTouch: width <= 390 });

    for (const { name, html, lang } of PAGES) {
      test(name, async ({ page }, testInfo) => {
        const { blocked } = await serve(page, html);
        await page.goto(`${ORIGIN}/`);
        // By element: the error page's h1 is an alert.
        await expect(page.locator("h1")).toBeVisible();
        // The self-hosted font loaded under the page's own policy, and nothing was refused.
        expect(await page.evaluate(() => document.fonts.check('16px "IBM Plex Sans Arabic"'))).toBe(true);
        expect(blocked).toEqual([]);
        await capture(page, testInfo, `customer-${name}-${String(width)}`);
        await expectLanguageAndFit(page, lang);
        await expectEveryControlNamed(page);
        await expectNoAxeViolations(page);
        await expectTouchTargets(page);
        await expectUsableInForcedColors(page);
      });
    }
  });
}
