import type { SyncResultCode } from "@cafe-loyalty/shared";
import { expect, test, type Page, type Route } from "@playwright/test";
import { reply } from "../dashboard/api-mock.js";
import { CATALOG, MENU, PAIRED, expectInBothLanguages, mockCounter, signedIn, syncAnswering } from "./fixtures.js";

/**
 * Every counter state the screens spec does not reach (UX Phase 6, K15), each checked like its screens (axe, touch
 * targets, forced colours, text spacing, text zoom, reflow) in English and then Arabic, on a tablet and a phone. Fake
 * data only. The page's clock is installed where a state needs time to pass or a request held open.
 */
test.use({ serviceWorkers: "block", timezoneId: "Asia/Beirut" });

const PAIR_CODE = "/pair#code=ABCD-1234-EFGH";
/** How long a recorded visit stays unsent for its Undo (UNDO_MS in apps/counter/src/visit.tsx), and a second more. */
const AFTER_UNDO = 11_000;

/** A route answered with an API error envelope. */
const failing = (status: number, code: string, message: string) => reply(status, { code, message, retryable: false });

/** A route that never answers until released (with the page's clock installed, its request never times out). */
function held(): { handler: (route: Route) => Promise<void>; release: (answer: (route: Route) => Promise<void>) => Promise<void> } {
  let waiting: Route | null = null;
  return {
    handler: async (route) => {
      waiting = route;
      await Promise.resolve();
    },
    release: async (answer) => {
      if (waiting !== null) {
        await answer(waiting);
      }
    },
  };
}

/** Pairs with the code and opens Rami's PIN screen. */
async function toPin(page: Page): Promise<void> {
  await page.goto(PAIR_CODE);
  await page.getByRole("button", { name: "Pair this phone" }).click();
  await page.getByRole("button", { name: "Rami" }).click();
}

/** Records a visit of one Latte for a typed phone number and lets its Undo pass, so it is sent. */
async function recordVisit(page: Page): Promise<void> {
  await page.getByRole("button", { name: "One more Latte" }).click();
  await page.getByLabel("No card? The customer's mobile number").fill("70 123 456");
  await page.getByRole("button", { name: "Record visit" }).click();
  await expect(page.getByRole("button", { name: "Undo the visit" })).toBeVisible();
  await page.clock.fastForward(AFTER_UNDO);
}

for (const { width, height } of [
  { width: 1024, height: 768 },
  { width: 360, height: 740 },
] as const) {
  test.describe(`counter states at ${String(width)} px`, () => {
    test.use({ viewport: { width, height }, isMobile: width < 640, hasTouch: true });

    test.describe("pairing", () => {
      test("a phone the owner removed", async ({ page }) => {
        await mockCounter(page, { "GET /api/device/staff": failing(401, "DEVICE_REVOKED", "The owner removed this phone. Ask them for a pairing code to use it again; its waiting stamps are kept.") });
        await page.goto(PAIR_CODE);
        await page.getByRole("button", { name: "Pair this phone" }).click();
        await expect(page.getByText(/^The owner removed this phone/)).toBeVisible();
        await expectInBothLanguages(page, /أزال المالك هذا الهاتف/);
      });

      test("a phone offline too long", async ({ page }) => {
        await mockCounter(page, { "GET /api/device/staff": failing(401, "PAIRING_REQUIRED", "This phone must be paired again.") });
        await page.goto(PAIR_CODE);
        await page.getByRole("button", { name: "Pair this phone" }).click();
        await expect(page.getByText(/^This phone was offline too long/)).toBeVisible();
        await expectInBothLanguages(page, /بقي هذا الهاتف دون اتصال مدة طويلة/);
      });

      test("a phone already paired", async ({ page }) => {
        await mockCounter(page);
        await page.goto(PAIR_CODE);
        await page.getByRole("button", { name: "Pair this phone" }).click();
        await expect(page.getByRole("button", { name: "Rami" })).toBeVisible();
        await page.goto("/pair");
        await expect(page.getByText(/^This phone is paired as Front counter at Café Najjar/)).toBeVisible();
        await expectInBothLanguages(page, /هذا الهاتف مربوط باسم/);
      });

      test("a phone paired elsewhere with a visit waiting", async ({ page }) => {
        await signedIn(page, {
          "POST /api/device/sync": syncAnswering(() => "TEMPORARILY_UNAVAILABLE"),
          "POST /api/device/pair": async (route) => {
            const body = route.request().postDataJSON() as { previous?: unknown };
            await (body.previous === undefined ? route.fulfill({ status: 201, json: PAIRED }) : failing(409, "PAIRED_ELSEWHERE", "This phone is paired with another café.")(route));
          },
        });
        await recordVisit(page);
        await page.goto(PAIR_CODE);
        await page.getByRole("button", { name: "Pair this phone" }).click();
        await expect(page.getByRole("button", { name: "Start over and discard it" })).toBeVisible();
        await expectInBothLanguages(page, "ابدأ من جديد واحذفه");
      });

      test("a pairing code refused", async ({ page }) => {
        await mockCounter(page, {
          "POST /api/device/pair": failing(400, "PAIRING_CODE_INVALID", "This pairing code is wrong, used or expired. Check it, or create a new code on the owner's dashboard."),
        });
        await page.goto(PAIR_CODE);
        await page.getByRole("button", { name: "Pair this phone" }).click();
        await expect(page.getByRole("alert")).toContainText("This pairing code is wrong");
        await expectInBothLanguages(page, /رمز الربط هذا خاطئ/);
      });

      test("pairing on its way", async ({ page }) => {
        await page.clock.install();
        const pairing = held();
        await mockCounter(page, { "POST /api/device/pair": pairing.handler });
        await page.goto(PAIR_CODE);
        await page.getByRole("button", { name: "Pair this phone" }).click();
        await expect(page.getByRole("button", { name: "Pairing…" })).toBeVisible();
        await expectInBothLanguages(page, "جارٍ الربط…");
      });
    });

    test.describe("signing in", () => {
      test("no baristas yet", async ({ page }) => {
        await mockCounter(page, { "GET /api/device/staff": reply(200, { staff: [] }) });
        await page.goto(PAIR_CODE);
        await page.getByRole("button", { name: "Pair this phone" }).click();
        await expect(page.getByText(/^No baristas yet/)).toBeVisible();
        await expectInBothLanguages(page, /لا باريستا بعد/);
      });

      test("no baristas yet, offline", async ({ page, context }) => {
        await mockCounter(page, { "GET /api/device/staff": reply(200, { staff: [] }) });
        await page.goto(PAIR_CODE);
        await page.getByRole("button", { name: "Pair this phone" }).click();
        await expect(page.getByText(/^No baristas yet/)).toBeVisible();
        await context.setOffline(true);
        await expect(page.getByText("Connect to the internet once to load the baristas.")).toBeVisible();
        await expectInBothLanguages(page, /اتصل بالإنترنت مرة واحدة لتحميل قائمة الباريستا/);
      });

      test("a barista locked out after five wrong PINs", async ({ page }) => {
        // A second lockout lasts a minute (each doubles), time for both languages' checks; the page's clock keeps running,
        // which axe needs.
        test.setTimeout(120_000);
        await page.clock.install();
        await mockCounter(page);
        await toPin(page);
        const lockOut = async () => {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            await page.getByLabel("PIN", { exact: true }).fill("111111");
            await page.getByRole("button", { name: "Sign in" }).click();
            await expect(page.getByRole("alert")).toContainText(/Wrong PIN|Too many wrong PINs/);
            if ((await page.getByRole("alert").textContent())?.startsWith("Too many") === true) {
              return;
            }
          }
        };
        await lockOut();
        await page.clock.fastForward(31_000);
        await expect(page.getByLabel("PIN", { exact: true })).toBeEnabled();
        await lockOut();
        await expect(page.getByRole("alert")).toContainText("Too many wrong PINs");
        await expectInBothLanguages(page, /رموز سرية خاطئة كثيرة/);
      });
    });

    test.describe("loading", () => {
      test("the phone's storage opening", async ({ page }) => {
        await page.addInitScript(() => {
          IDBFactory.prototype.open = () => ({}) as IDBOpenDBRequest;
        });
        await mockCounter(page);
        await page.goto(PAIR_CODE);
        await expect(page.getByText("Loading…")).toBeVisible();
        await expectInBothLanguages(page, "جارٍ التحميل…");
      });

      test("the menu loading, and offline before it loads", async ({ page, context }) => {
        await page.clock.install();
        const menu = held();
        await mockCounter(page, { "GET /api/device/catalog": menu.handler });
        await toPin(page);
        await page.getByLabel("PIN", { exact: true }).fill("482913");
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByText("Loading the menu…")).toBeVisible();
        await expectInBothLanguages(page, "جارٍ تحميل القائمة…");
        await context.setOffline(true);
        await expect(page.getByText(/اتصل بالإنترنت مرة واحدة لتحميل القائمة/)).toBeVisible();
        await page.getByRole("button", { name: "English" }).click();
        await expectInBothLanguages(page, /اتصل بالإنترنت مرة واحدة لتحميل القائمة/);
      });

      test("nothing on sale", async ({ page }) => {
        await page.clock.install();
        await mockCounter(page, { "GET /api/device/catalog": reply(200, { ...CATALOG, orderTypes: [] }) });
        await toPin(page);
        await page.getByLabel("PIN", { exact: true }).fill("482913");
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByText(/^Nothing is on sale yet/)).toBeVisible();
        await expectInBothLanguages(page, /لا شيء معروض للبيع بعد/);
      });
    });

    test.describe("sending", () => {
      test("the server unreachable after a refused visit, with the refused list", async ({ page }) => {
        let sync: (route: Route) => Promise<void> = syncAnswering(() => "CARD_NOT_FOUND");
        await signedIn(page, {
          "POST /api/device/sync": async (route) => {
            await sync(route);
          },
        });
        await recordVisit(page);
        await expect(page.getByRole("heading", { name: "Not accepted by the server" })).toBeVisible();
        sync = (route) => route.abort();
        await recordVisit(page);
        await expect(page.getByRole("status").first()).toHaveText(/^Can't reach server/);
        await expect(page.getByRole("link", { name: /refused/ })).toBeVisible();
        // The last-sent time is shown from 40rem up, and read to screen readers on a phone.
        await expect(page.getByText(/Last sent \d/).first()).toBeAttached();
        await expectInBothLanguages(page, "الخادم لا يجيب");
      });

      test("the refused list failing to clear", async ({ page }) => {
        await signedIn(page, { "POST /api/device/sync": syncAnswering(() => "CARD_NOT_FOUND") });
        await recordVisit(page);
        await expect(page.getByRole("heading", { name: "Not accepted by the server" })).toBeVisible();
        await page.evaluate(() => {
          IDBObjectStore.prototype.clear = () => {
            throw new DOMException("Fake failure for the test.", "UnknownError");
          };
        });
        await page.getByRole("button", { name: "Clear list" }).click();
        await expect(page.getByRole("alert")).toContainText("The list could not be cleared.");
        await expectInBothLanguages(page, /تعذّر مسح القائمة/);
      });

      for (const [code, english, arabic] of [
        ["STAMP_COOLDOWN", "less than 30 minutes before", /قبل أقل من 30 دقيقة/],
        ["DAILY_STAMP_CAP", "reached its stamps for today", /بلغ حدّ أختامه لهذا اليوم/],
        ["CARD_GONE", "the card was deleted", /لأن البطاقة حُذفت/],
        ["HELD_FOR_REVIEW", "held for the owner to check", /أُوقفت ليراجعها المالك/],
        ["OK", "recorded.", /سُجّلت\./],
      ] as const) {
        test(`the last visit's outcome: ${code}`, async ({ page }) => {
          await signedIn(page, { "POST /api/device/sync": syncAnswering(() => code satisfies SyncResultCode) });
          await recordVisit(page);
          await expect(page.getByText(/^Last visit, at /)).toContainText(english);
          await expectInBothLanguages(page, arabic);
        });
      }
    });

    test.describe("a visit", () => {
      test("another café's card", async ({ page }) => {
        await signedIn(page, { "POST /api/device/pair": reply(201, { ...PAIRED, cafe: { id: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c99", name: "Café Najjar" } }) });
        await page.getByRole("button", { name: "Scan card", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("That card is for another café.");
        await expectInBothLanguages(page, /هذه البطاقة لمقهى آخر/);
      });

      test("an order with no card or phone", async ({ page }) => {
        await signedIn(page);
        await page.getByRole("button", { name: "One more Latte" }).click();
        await page.getByRole("button", { name: "Record visit" }).click();
        await expect(page.getByRole("alert")).toContainText("Scan the customer's card, or enter their mobile number.");
        await expectInBothLanguages(page, /امسح بطاقة الزبون، أو أدخل رقم هاتفه المحمول/);
      });

      test("an item taken off sale while in the order", async ({ page, context }) => {
        let catalog: unknown = CATALOG;
        await signedIn(page, {
          "GET /api/device/catalog": async (route) => {
            await route.fulfill({ json: catalog });
          },
        });
        await page.getByRole("button", { name: "One more Latte" }).click();
        catalog = { ...CATALOG, catalogVersion: 5, orderTypes: MENU.filter((item) => item.nameEn !== "Latte") };
        // Back online, the counter loads the staff and the menu again.
        await context.setOffline(true);
        await expect(page.getByRole("status").first()).toHaveText(/^Offline/);
        await context.setOffline(false);
        await expect(page.getByRole("alert")).toContainText("No longer on sale, so left out of this order: Latte.");
        await expectInBothLanguages(page, /لم يعد معروضاً للبيع/);
      });

      test("a welcome-back offer that takes nothing off", async ({ page }) => {
        await signedIn(page, {
          "GET /api/device/catalog": reply(200, {
            ...CATALOG,
            winBackOffers: [{ cardId: "5e6f7a8b-9c0d-4e5f-8a6b-7c8d9e0f1a2b", discount: { kind: "percent", value: 10 }, minMarginPercent: 30 }],
          }),
          "POST /api/device/cards/status": reply(200, { stamps: 2, rewardReady: false }),
        });
        await page.getByRole("button", { name: "One more Latte" }).click();
        await page.getByRole("button", { name: "Scan card", exact: true }).click();
        const offer = page.getByRole("checkbox", { name: /^Apply the welcome-back offer/ });
        await offer.check();
        await expect(page.getByText(/^The offer takes nothing off this order/)).toBeVisible();
        await expectInBothLanguages(page, /طبّق عرض العودة/);
        await expect(page.getByText(/^لا يخصم العرض شيئاً من هذا الطلب/)).toBeVisible();
      });

      test("a saved visit with its Undo", async ({ page }) => {
        await signedIn(page);
        await page.getByRole("button", { name: "One more Latte" }).click();
        await page.getByLabel("No card? The customer's mobile number").fill("70 123 456");
        await page.getByRole("button", { name: "Record visit" }).click();
        await expect(page.getByRole("button", { name: "Undo the visit" })).toBeVisible();
        await expectInBothLanguages(page, "يمكن التراجع عنها خلال 10 ثوانٍ.");
      });

      test("a card with its reward ready", async ({ page }) => {
        await signedIn(page);
        await page.getByRole("button", { name: "Scan card", exact: true }).click();
        await expect(page.locator(".reward-ready").getByText("Reward ready: Free coffee.")).toBeVisible();
        await expectInBothLanguages(page, /المكافأة جاهزة/);
      });

      test("switching barista with an order open", async ({ page }) => {
        await signedIn(page);
        await page.getByRole("button", { name: "One more Latte" }).click();
        await page.getByRole("button", { name: "Switch barista" }).click();
        await expect(page.getByRole("button", { name: "Keep the order" })).toBeFocused();
        await expectInBothLanguages(page, "أبقِ الطلب");
      });

      test("a reward given from the visit", async ({ page }) => {
        await signedIn(page, { "POST /api/device/redemptions": reply(201, { stampsUsed: 9, stampsLeft: 2, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" }) });
        await page.getByRole("button", { name: "Scan card", exact: true }).click();
        await page.getByRole("button", { name: "Give Free coffee now" }).click();
        await expect(page.getByText(/^Reward given: Free coffee/).first()).toBeVisible();
        await expectInBothLanguages(page, /مُنحت المكافأة/);
      });
    });

    test.describe("a reward", () => {
      test("on its way", async ({ page }) => {
        const giving = held();
        await signedIn(page, { "POST /api/device/redemptions": giving.handler });
        await page.getByRole("button", { name: "Scan card for a reward" }).click();
        await expect(page.getByRole("button", { name: "Sending…" })).toBeVisible();
        await expectInBothLanguages(page, "جارٍ الإرسال…");
      });

      test("offline", async ({ page, context }) => {
        await signedIn(page);
        await context.setOffline(true);
        await expect(page.getByText(/^Rewards need an internet connection/)).toBeVisible();
        await expectInBothLanguages(page, /المكافآت تحتاج إلى اتصال بالإنترنت/);
      });

      test("not confirmed, with Try again", async ({ page }) => {
        await signedIn(page, { "POST /api/device/redemptions": (route) => route.abort() });
        await page.getByRole("button", { name: "Scan card for a reward" }).click();
        await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
        await expectInBothLanguages(page, "حاول مجدداً");
      });

      test("given", async ({ page }) => {
        await signedIn(page, { "POST /api/device/redemptions": reply(201, { stampsUsed: 9, stampsLeft: 2, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" }) });
        await page.getByRole("button", { name: "Scan card for a reward" }).click();
        await expect(page.getByText("Reward given: Free coffee. 2 stamps left on the card.")).toBeVisible();
        await expectInBothLanguages(page, /مُنحت المكافأة/);
      });
    });

    test.describe("notices", () => {
      test("signed out after four idle hours", async ({ page }) => {
        await signedIn(page);
        await page.clock.fastForward("04:01:00");
        await expect(page.getByText("The barista was signed out after 4 hours without use.")).toBeVisible();
        await expectInBothLanguages(page, /سُجّل خروج الباريستا/);
      });

      test("an idle order cleared", async ({ page }) => {
        await signedIn(page);
        await page.getByRole("button", { name: "One more Latte" }).click();
        await page.clock.fastForward(5 * 60_000);
        await expect(page.getByText("The open order was cleared after 5 minutes without use.")).toBeVisible();
        await expectInBothLanguages(page, /مُسح الطلب المفتوح/);
      });

      test("the phone's storage unreadable", async ({ page }) => {
        await page.addInitScript(() => {
          IDBFactory.prototype.open = () => {
            throw new Error("Fake failure for the test.");
          };
        });
        await mockCounter(page);
        await page.goto(PAIR_CODE);
        await expect(page.getByText(/^This phone's storage could not be read/)).toBeVisible();
        await expectInBothLanguages(page, /تعذّرت قراءة ذاكرة هذا الهاتف/);
      });

      test("the phone's storage busy in another tab", async ({ page }) => {
        await page.addInitScript(() => {
          IDBFactory.prototype.open = () => {
            const request = {} as IDBOpenDBRequest;
            queueMicrotask(() => {
              request.onblocked?.(new Event("blocked") as IDBVersionChangeEvent);
            });
            return request;
          };
        });
        await mockCounter(page);
        await page.goto(PAIR_CODE);
        await expect(page.getByText(/^This phone's storage is busy in another tab/)).toBeVisible();
        await expectInBothLanguages(page, /تخزين هذا الهاتف مشغول/);
      });

      test("the app out of date", async ({ page }) => {
        await mockCounter(page, {
          "GET /api/device/staff": failing(426, "CLIENT_TOO_OLD", "This counter app is out of date. Keep the phone online: it sends its waiting stamps, then updates itself."),
        });
        await page.goto(PAIR_CODE);
        await page.getByRole("button", { name: "Pair this phone" }).click();
        await expect(page.getByText(/^This counter app is out of date/)).toBeVisible();
        await expectInBothLanguages(page, /تطبيق الكاونتر هذا قديم/);
      });
    });

    test.describe("offline use", () => {
      test.use({ serviceWorkers: "allow" });

      test("a browser that cannot keep the app", async ({ page }) => {
        await page.addInitScript(() => {
          delete (Navigator.prototype as { serviceWorker?: unknown }).serviceWorker;
        });
        await mockCounter(page);
        await page.goto(PAIR_CODE);
        await expect(page.getByText(/^This browser cannot keep the app for offline use/)).toBeVisible();
        await expectInBothLanguages(page, /لا يستطيع هذا المتصفح/);
      });

      test("an update ready", async ({ page }) => {
        // A registration with a new build waiting, as the browser gives once one is installed; told to take over, it stays.
        await page.addInitScript(() => {
          const ignore = () => undefined;
          const registration = {
            waiting: { state: "installed", addEventListener: ignore, postMessage: ignore },
            installing: null,
            addEventListener: ignore,
            update: () => Promise.resolve(),
          };
          ServiceWorkerContainer.prototype.register = () => Promise.resolve(registration as unknown as ServiceWorkerRegistration);
        });
        await mockCounter(page);
        await page.goto(PAIR_CODE);
        await expect(page.getByText(/^An update is ready/)).toBeVisible();
        await expectInBothLanguages(page, /تحديث جاهز/);
      });
    });
  });
}
