import { pbkdf2Sync, randomBytes } from "node:crypto";
import { expect, test, type Route } from "@playwright/test";
import { mockApi, reply } from "../dashboard/api-mock.js";

// Network mocks only: the service worker is tested on its own (offline.spec.ts).
test.use({ serviceWorkers: "block" });

const CAFE = { id: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", name: "Café Najjar" };
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

const json = (route: Route): unknown => route.request().postDataJSON();

test("pairs from the dashboard's QR link, locks a barista out after five wrong PINs and reports it at sync", async ({ page }) => {
  const synced: unknown[] = [];
  await mockApi(page, {
    "POST /api/device/pair": async (route) => {
      expect(route.request().headers()["x-counter-built-at"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(json(route)).toMatchObject({ code: "ABCD1234EFGH", publicKey: { kty: "EC", crv: "P-256" } });
      await route.fulfill({ status: 201, json: PAIRED });
    },
    "GET /api/device/staff": reply(200, { staff: [RAMI] }),
    "POST /api/device/sync": async (route) => {
      expect(route.request().headers().authorization).toBe(`Bearer ${PAIRED.accessToken}`);
      const { events } = json(route) as { events: unknown[] };
      synced.push(...events);
      await route.fulfill({ json: { results: events.map((_, index) => ({ index, eventId: null, status: "applied", code: "OK" })) } });
    },
  });
  await page.goto("/pair#code=ABCD-1234-EFGH");
  await expect(page.getByLabel("Pairing code")).toHaveValue("ABCD-1234-EFGH");
  expect(new URL(page.url()).hash).toBe("");
  await page.getByRole("button", { name: "Pair this phone" }).click();

  await page.getByRole("button", { name: "Rami" }).click();
  await expect(page.getByRole("heading", { name: "PIN for Rami" })).toBeFocused();
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await page.getByLabel("PIN", { exact: true }).fill("111111");
    await page.getByRole("button", { name: "Sign in" }).click();
    // Each answer, not just the button coming back, before the next try.
    await expect(page.getByRole("alert")).toHaveText(`Wrong PIN. ${String(5 - attempt)} ${attempt === 4 ? "try" : "tries"} left before a pause.`);
  }
  await page.getByLabel("PIN", { exact: true }).fill("111111");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(/^Too many wrong PINs\. Rami can try again at /);
  await expect(page.getByLabel("PIN", { exact: true })).toBeDisabled();
  // The report is sent at once; wait for it rather than for a status line that was already there.
  await expect.poll(() => synced).toMatchObject([{ type: "staff.pin_lockout", staffId: RAMI.id, deviceId: PAIRED.deviceId, payload: { failedAttempts: 5 } }]);
  await expect(page.getByText("Nothing waiting to send.")).toBeVisible();

  // The lockout is kept on the phone: a reload does not lift it.
  await page.reload();
  await page.getByRole("button", { name: "Rami" }).click();
  await expect(page.getByLabel("PIN", { exact: true })).toBeDisabled();
});

test("signs a barista in with the right PIN and keeps them until switched", async ({ page }) => {
  await mockApi(page, {
    "POST /api/device/pair": reply(201, PAIRED),
    "GET /api/device/staff": reply(200, { staff: [RAMI] }),
  });
  await page.goto("/pair");
  await page.getByLabel("Pairing code").fill("abcd 1234 efgh");
  await page.getByRole("button", { name: "Pair this phone" }).click();
  await page.getByRole("button", { name: "Rami" }).click();
  await page.getByLabel("PIN", { exact: true }).fill("482913");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: CAFE.name })).toBeVisible();
  await expect(page.getByText("Signed in as Rami on Front counter.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Signed in as Rami on Front counter.")).toBeVisible();
  await page.getByRole("button", { name: "Switch barista" }).click();
  await expect(page.getByRole("heading", { name: "Who is working?" })).toBeFocused();
});

test("explains a refused pairing code", async ({ page }) => {
  await mockApi(page, {
    "POST /api/device/pair": reply(400, { code: "PAIRING_CODE_INVALID", message: "This pairing code is wrong, used or expired.", retryable: false }),
  });
  await page.goto("/pair");
  await page.getByLabel("Pairing code").fill("ABCD-1234-EFGH");
  await page.getByRole("button", { name: "Pair this phone" }).click();
  await expect(page.getByRole("alert")).toHaveText("This pairing code is wrong, used or expired.");
});
