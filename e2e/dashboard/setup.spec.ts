import { expect, test, type Route } from "@playwright/test";
import { SESSION, UNAUTHENTICATED, mockApi, reply } from "./api-mock.js";

const CAFE = { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1 };
const ESPRESSO = { id: "3d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f41", nameAr: "إسبريسو", nameEn: "Espresso", priceCents: 250, costCents: 70, stampsEarned: 1, active: true };
const PROGRAM = { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" };

const json = (route: Route): unknown => route.request().postDataJSON();

test("saves the program, then adds and edits an order type", async ({ page }) => {
  let setup: { cafe: typeof CAFE; program: typeof PROGRAM | null; orderTypes: (typeof ESPRESSO)[] } = { cafe: CAFE, program: null, orderTypes: [] };
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": (route) => route.fulfill({ json: setup }),
    "PUT /api/cafe/program": async (route) => {
      expect(json(route)).toEqual(PROGRAM);
      setup = { ...setup, program: PROGRAM };
      await route.fulfill({ json: setup });
    },
    "POST /api/cafe/order-types": async (route) => {
      expect(json(route)).toEqual({ nameEn: "Espresso", nameAr: "إسبريسو", priceCents: 250, costCents: 70, stampsEarned: 1, active: true });
      setup = { ...setup, cafe: { ...CAFE, catalogVersion: 2 }, orderTypes: [ESPRESSO] };
      await route.fulfill({ status: 201, json: setup });
    },
    [`PATCH /api/cafe/order-types/${ESPRESSO.id}`]: async (route) => {
      expect(json(route)).toMatchObject({ priceCents: 275 });
      setup = { ...setup, orderTypes: [{ ...ESPRESSO, priceCents: 275 }] };
      await route.fulfill({ json: setup });
    },
  });
  await page.goto("/cafe");
  await expect(page.getByText("Set the program before baristas start giving stamps.")).toBeVisible();
  await page.getByLabel("Stamps for a reward").fill("9");
  await page.getByLabel("Reward (English)").fill("Free coffee");
  await page.getByLabel("Reward (Arabic)").fill("قهوة مجانية");
  await expect(page.getByLabel("Reward (Arabic)")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "Save program" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");

  const add = page.getByRole("form", { name: "Add an order type" });
  await add.getByLabel("Name (English)").fill("Espresso");
  await add.getByLabel("Name (Arabic)").fill("إسبريسو");
  await add.getByLabel("Price (USD)").fill("2.50");
  await add.getByLabel("Cost to make (USD)").fill("0.70");
  await add.getByRole("button", { name: "Add order type" }).click();
  await expect(page.getByText("$2.50 · cost $0.70 · 1 stamp")).toBeVisible();

  await page.getByRole("button", { name: "Edit Espresso" }).click();
  await expect(page.getByRole("form", { name: "Edit Espresso" }).getByLabel("Name (English)")).toBeFocused();
  await page.getByRole("form", { name: "Edit Espresso" }).getByLabel("Price (USD)").fill("2.75");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("$2.75 · cost $0.70 · 1 stamp")).toBeVisible();
});

test("explains a price that is not an amount without calling the server", async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(200, SESSION), "GET /api/cafe": reply(200, { cafe: CAFE, program: PROGRAM, orderTypes: [] }) });
  await page.goto("/cafe");
  const add = page.getByRole("form", { name: "Add an order type" });
  await add.getByLabel("Name (English)").fill("Latte");
  await add.getByLabel("Name (Arabic)").fill("لاتيه");
  await add.getByLabel("Price (USD)").fill("2,50");
  await add.getByLabel("Cost to make (USD)").fill("0.90");
  await add.getByRole("button", { name: "Add order type" }).click();
  await expect(add.getByText("Enter a price in dollars up to 1,000,000, such as 2.50.")).toBeVisible();
});

test("adds a barista with a PIN and removes one after confirming", async ({ page }) => {
  const rami = { id: "5d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f42", name: "Rami", revoked: false, createdAt: "2026-10-08T12:00:00.000Z" };
  let staff = [] as (typeof rami)[];
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/staff": (route) => route.fulfill({ json: { staff } }),
    "POST /api/staff": async (route) => {
      expect(json(route)).toEqual({ name: "Rami", pin: "482913" });
      staff = [rami];
      await route.fulfill({ status: 201, json: { staff } });
    },
    [`POST /api/staff/${rami.id}/revoke`]: async (route) => {
      staff = [{ ...rami, revoked: true }];
      await route.fulfill({ json: { staff } });
    },
  });
  await page.goto("/staff");
  await page.getByLabel("Name").fill("Rami");
  await expect(page.getByLabel("PIN")).toHaveAttribute("inputmode", "numeric");
  await page.getByLabel("PIN").fill("482913");
  await page.getByRole("button", { name: "Add barista" }).click();
  await expect(page.getByRole("status")).toContainText("Saved.");

  await page.getByRole("button", { name: "Remove Rami" }).click();
  // Focus follows the control that replaced the one pressed.
  await expect(page.getByRole("button", { name: "Yes, remove Rami" })).toBeFocused();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Remove Rami" })).toBeFocused();
  await page.getByRole("button", { name: "Remove Rami" }).click();
  await page.getByRole("button", { name: "Yes, remove Rami" }).click();
  await expect(page.getByText("Rami · removed")).toBeVisible();
});

test("shows the server's PIN rule", async ({ page }) => {
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/staff": reply(200, { staff: [] }),
    "POST /api/staff": reply(400, {
      code: "VALIDATION_FAILED",
      message: "Some fields are missing or not valid. Check them and try again.",
      retryable: false,
      details: [{ path: "pin", issue: "Choose a PIN that is harder to guess than a repeated digit or a straight run such as 123456." }],
    }),
  });
  await page.goto("/staff");
  await page.getByLabel("Name").fill("Rami");
  await page.getByLabel("PIN").fill("123456");
  await page.getByRole("button", { name: "Add barista" }).click();
  await expect(page.getByText("Choose a PIN that is harder to guess")).toBeVisible();
  await expect(page.getByLabel("PIN")).toHaveAttribute("aria-invalid", "true");
});

test("pairs a phone with a code and a QR, and removes a phone", async ({ page }) => {
  const counter = { id: "7d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f43", name: "Front counter", pairedAt: "2026-10-08T12:00:00.000Z", lastSeenAt: "2026-10-08T12:30:00.000Z", revoked: false };
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/devices": reply(200, { devices: [counter], pairingCodes: [] }),
    "POST /api/devices/pairing-codes": async (route) => {
      expect(json(route)).toEqual({ deviceName: "Back bar" });
      await route.fulfill({
        status: 201,
        json: {
          id: "8d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f44",
          deviceName: "Back bar",
          code: "ABCD-EFGH-JKMN",
          pairingUrl: "https://counter.example.test/pair#code=ABCDEFGHJKMN",
          expiresAt: "2026-10-08T12:40:00.000Z",
        },
      });
    },
    [`POST /api/devices/${counter.id}/revoke`]: reply(200, { devices: [{ ...counter, revoked: true }], pairingCodes: [] }),
  });
  await page.goto("/devices");
  await page.getByLabel("Phone name").fill("Back bar");
  await page.getByRole("button", { name: "Create pairing code" }).click();
  await expect(page.getByRole("heading", { name: "Pair Back bar" })).toBeFocused();
  await expect(page.getByText("ABCD-EFGH-JKMN")).toBeVisible();
  const qr = page.getByRole("img", { name: "QR code to pair Back bar" });
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((image: HTMLImageElement) => image.naturalWidth > 0 && image.src.startsWith("data:image/svg+xml"))).toBe(true);

  await page.getByRole("button", { name: "Remove Front counter" }).click();
  await page.getByRole("button", { name: "Yes, remove Front counter" }).click();
  await expect(page.getByRole("status")).toHaveText("Front counter is removed. It stops working the next time it connects.");
});

test("returns to sign-in when the session ends on a page", async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(200, SESSION), "GET /api/staff": reply(401, UNAUTHENTICATED) });
  await page.goto("/staff");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Your session has ended. Sign in again.");
});
