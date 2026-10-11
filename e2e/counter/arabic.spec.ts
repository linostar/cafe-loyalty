import { pbkdf2Sync, randomBytes } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectEveryControlNamed, expectLanguageAndFit } from "../a11y.js";
import { mockApi, reply } from "../dashboard/api-mock.js";

/**
 * The counter in Arabic on a 360 px phone (AC 41): its screens right to left, fitting, every control named, and the
 * messages a barista must understand (wrong PIN, lockout, events the server refused) in Arabic (AC 42).
 */
test.use({ serviceWorkers: "block", locale: "ar-LB" });

const PAIRED = {
  deviceId: "7e57d3c1-0000-4000-8000-000000000001",
  keyId: "7e57d3c1-0000-4000-8000-000000000002",
  deviceName: "Front counter",
  cafe: { id: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", name: "Café Najjar" },
  // Fake test token shaped like a real one; never a real credential.
  accessToken: "e2eFakeDeviceToken_0123456789abcdefghijklm",
  accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
};
const salt = randomBytes(16);
const RAMI = {
  id: "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e",
  name: "Rami",
  pinSalt: salt.toString("base64url"),
  pinHash: pbkdf2Sync("482913", salt, 1000, 32, "sha256").toString("base64url"),
  pinIterations: 1000,
};
const COFFEE = { id: "3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f", nameAr: "قهوة", nameEn: "Coffee", priceCents: 300, costCents: 90, stampsEarned: 1 };
const CATALOG = {
  catalogVersion: 4,
  timeZone: "Asia/Beirut",
  campaigns: [] as unknown[],
  winBackOffers: [] as unknown[],
  orderTypes: [COFFEE],
  program: { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" },
};

const check = async (page: Page) => {
  await expectLanguageAndFit(page, "ar");
  await expectEveryControlNamed(page);
};

async function toPin(page: Page, sync: (route: Route) => Promise<void>): Promise<void> {
  await mockApi(page, {
    "POST /api/device/pair": reply(201, PAIRED),
    "GET /api/device/staff": reply(200, { staff: [RAMI] }),
    "GET /api/device/catalog": reply(200, CATALOG),
    "POST /api/device/sync": sync,
  });
  await page.goto("/pair#code=ABCD-1234-EFGH");
  await expect(page.getByRole("heading", { name: "اربط هذا الهاتف" })).toBeVisible();
  await check(page);
  await page.getByRole("button", { name: "اربط هذا الهاتف" }).click();
  await page.getByRole("button", { name: "Rami" }).click();
  await expect(page.getByRole("heading", { name: /الرمز السري لـ/ })).toBeFocused();
  await check(page);
}

const answer = (status: string, code: string) => async (route: Route) => {
  const { events } = route.request().postDataJSON() as { events: unknown[] };
  await route.fulfill({ json: { results: events.map((_, index) => ({ index, eventId: null, status, code })) } });
};

test("tells a barista in Arabic how many PIN tries are left, then pauses them", async ({ page }) => {
  await toPin(page, answer("applied", "OK"));
  const tries = ["بقيت 4 محاولات", "بقيت 3 محاولات", "بقيت محاولتان", "بقيت محاولة واحدة"];
  for (const left of tries) {
    await page.getByLabel("الرمز السري", { exact: true }).fill("111111");
    await page.getByRole("button", { name: "تسجيل الدخول" }).click();
    await expect(page.getByRole("alert")).toHaveText(new RegExp(`^رمز سري خاطئ\\. ${left.replace(/(\d)/, "⁨$1⁩")}`));
  }
  await page.getByLabel("الرمز السري", { exact: true }).fill("111111");
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.getByRole("alert")).toHaveText(/^رموز سرية خاطئة كثيرة\./);
  await expect(page.getByLabel("الرمز السري", { exact: true })).toBeDisabled();
  await check(page);
});

test("lists a visit the server refused, in Arabic, and says why", async ({ page }) => {
  await toPin(page, answer("rejected", "CARD_NOT_FOUND"));
  // Typed on an Arabic keypad: the same PIN.
  await page.getByLabel("الرمز السري", { exact: true }).fill("٤٨٢٩١٣");
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.getByRole("heading", { name: "زيارة جديدة" })).toBeVisible();
  await page.getByRole("button", { name: /^زيادة .*قهوة/ }).click();
  await page.getByLabel("أو رقم هاتف الزبون المحمول").fill("٧٠ ١٢٣ ٤٥٦");
  await page.getByRole("button", { name: "تسجيل الزيارة" }).click();
  const rejected = page.getByRole("region", { name: "لم يقبلها الخادم" });
  await expect(rejected).toBeVisible();
  await expect(rejected.getByRole("listitem")).toHaveCount(1);
  await expect(rejected.getByRole("listitem")).not.toContainText("card is not");
  await check(page);
});
