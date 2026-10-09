import { pbkdf2Sync, randomBytes } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { mockApi, reply } from "../dashboard/api-mock.js";
import { CAMERA_CAFE_ID, CAMERA_CARD_QR } from "./camera.js";

// Network mocks only: the service worker is tested on its own (offline.spec.ts).
test.use({ serviceWorkers: "block" });

const CAFE = { id: CAMERA_CAFE_ID, name: "Café Najjar" };
const PAIRED = {
  deviceId: "7e57d3c1-0000-4000-8000-000000000001",
  keyId: "7e57d3c1-0000-4000-8000-000000000002",
  deviceName: "Front counter",
  cafe: CAFE,
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
const CATALOG = { catalogVersion: 4, orderTypes: [COFFEE], program: { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" } };

const json = (route: Route): unknown => route.request().postDataJSON();

/** Pairs the counter and signs Rami in, with the API answering `extra` routes too. Returns what the counter synced. */
async function signedIn(page: Page, extra: Parameters<typeof mockApi>[1] = {}): Promise<unknown[]> {
  const synced: unknown[] = [];
  await mockApi(page, {
    "POST /api/device/pair": reply(201, PAIRED),
    "GET /api/device/staff": reply(200, { staff: [RAMI] }),
    "GET /api/device/catalog": reply(200, CATALOG),
    "POST /api/device/sync": async (route) => {
      const { events } = json(route) as { events: unknown[] };
      synced.push(...events);
      await route.fulfill({ json: { results: events.map((_, index) => ({ index, eventId: null, status: "applied", code: "OK" })) } });
    },
    ...extra,
  });
  await page.goto("/pair#code=ABCD-1234-EFGH");
  await page.getByRole("button", { name: "Pair this phone" }).click();
  await page.getByRole("button", { name: "Rami" }).click();
  await page.getByLabel("PIN", { exact: true }).fill("482913");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "New visit" })).toBeVisible();
  return synced;
}

test("records a visit for a phone number and sends it, priced as the menu showed it (AC 22, 32)", async ({ page }) => {
  const synced = await signedIn(page);
  await page.getByRole("button", { name: "One more Coffee" }).click();
  await page.getByRole("button", { name: "One more Coffee" }).click();
  await expect(page.getByText("Total $6.00 · 2 stamps")).toBeVisible();
  await page.getByLabel("Or the customer's mobile number").fill("70 123 456");
  await page.getByRole("button", { name: "Record visit" }).click();
  await expect(page.getByText("Visit saved: 2 stamps for this card.", { exact: false })).toBeVisible();
  await expect
    .poll(() => synced)
    .toMatchObject([
      {
        type: "visit.recorded",
        staffId: RAMI.id,
        deviceId: PAIRED.deviceId,
        payload: { card: { kind: "phone", phone: "+96170123456" }, items: [{ orderTypeId: COFFEE.id, quantity: 2, unitPriceCents: 300, catalogVersion: 4 }], totalCents: 600 },
      },
    ]);
});

test("scans the customer's card with the camera for a visit", async ({ page }) => {
  const synced = await signedIn(page);
  await page.getByRole("button", { name: "One more Coffee" }).click();
  await page.getByRole("button", { name: "Scan card", exact: true }).click();
  await expect(page.getByText("Card scanned.")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Record visit" }).click();
  await expect.poll(() => synced).toMatchObject([{ payload: { card: { kind: "qr", token: CAMERA_CARD_QR } } }]);
});

test("gives a reward for a scanned card online, and refuses one offline (AC 31)", async ({ page, context }) => {
  await signedIn(page, {
    "POST /api/device/redemptions": async (route) => {
      expect(json(route)).toMatchObject({ staffId: RAMI.id, cardQr: CAMERA_CARD_QR });
      await route.fulfill({ status: 201, json: { stampsUsed: 9, stampsLeft: 2, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" } });
    },
  });
  await page.getByRole("button", { name: "Scan card for a reward" }).click();
  await expect(page.getByText("Reward given: Free coffee. 2 stamps left on the card.")).toBeVisible({ timeout: 15_000 });

  await context.setOffline(true);
  await expect(page.getByText("Rewards need an internet connection. Connect the phone, then try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan card for a reward" })).toBeDisabled();
});
