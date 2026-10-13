import { expect, test } from "@playwright/test";
import { UNAUTHENTICATED, mockApi, reply } from "./api-mock.js";

test.use({ timezoneId: "UTC" });

// Fake operator and cafés for the test only.
const OPERATOR = { operator: { id: "c01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", email: "operator@example.com" } };
const CAFE_ID = "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d";
const cafe = (overrides: Record<string, unknown> = {}) => ({
  id: CAFE_ID,
  name: "Café Najjar",
  plan: "pilot",
  createdAt: "2026-09-01T08:00:00.000Z",
  paidCents: 0,
  payments: [],
  ...overrides,
});

test("the operator signs in, suspends a café, records a payment and signs out (AC 39)", async ({ page }) => {
  const sent: unknown[] = [];
  let signedIn = false;
  await mockApi(page, {
    "GET /api/admin/session": (route) => (signedIn ? route.fulfill({ json: OPERATOR }) : route.fulfill({ status: 401, json: UNAUTHENTICATED })),
    "POST /api/admin/login": async (route) => {
      signedIn = true;
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: OPERATOR });
    },
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    [`PATCH /api/admin/cafes/${CAFE_ID}`]: async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: cafe({ plan: "suspended" }) });
    },
    [`POST /api/admin/cafes/${CAFE_ID}/payments`]: async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({
        status: 201,
        json: cafe({
          plan: "suspended",
          paidCents: 2500,
          payments: [{ id: "d01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", amountCents: 2500, paidOn: "2026-10-01", method: "whish", reference: "W-1042", recordedAt: "2026-10-01T09:00:00.000Z" }],
        }),
      });
    },
    "POST /api/admin/logout": reply(204),
  });
  await page.goto("/admin");
  await page.getByLabel("Email").fill("operator@example.com");
  await page.getByLabel("Password").fill("fake-operator-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Cafés" })).toBeVisible();

  const card = page.getByRole("region", { name: /Café Najjar/ });
  await expect(card.getByRole("button", { name: "Save plan" })).toBeDisabled();
  await card.getByRole("group", { name: "Plan of Café Najjar" }).getByLabel("Suspended").check();
  await expect(card.getByText("Its signup page enrols no one; its counter still records and syncs visits.")).toBeVisible();
  await card.getByRole("button", { name: "Save plan" }).click();
  await expect(page.getByRole("status")).toHaveText("Café Najjar is now on the suspended plan.");
  await expect(card.getByRole("heading", { level: 3, name: /Café Najjar/ })).toContainText("Suspended");

  // An amount the form cannot read is caught before anything is sent.
  await card.getByLabel("Amount (USD)").fill("twenty");
  await card.getByRole("button", { name: "Record payment" }).click();
  await expect(card.getByText("Enter an amount in dollars over 0, such as 25 or 25.00.")).toBeVisible();
  await card.getByLabel("Amount (USD)").fill("25");
  await card.getByLabel("Paid on").fill("2026-10-01");
  await card.getByLabel("Whish").check();
  await card.getByLabel("Reference").fill("W-1042");
  await card.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByRole("status")).toHaveText("Recorded $25.00 from Café Najjar, paid by Whish on 1 Oct 2026.");
  await expect(card.getByRole("table", { name: "Latest payments of Café Najjar" }).getByRole("row", { name: /1 Oct 2026 \$25\.00 Whish W-1042/ })).toBeVisible();
  await expect(card.getByLabel("Amount (USD)")).toHaveValue("");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Operator sign-in" })).toBeVisible();
  await expect(page.getByText("You signed out on every device.")).toBeVisible();
  expect(sent).toEqual([
    { email: "operator@example.com", password: "fake-operator-password" },
    { plan: "suspended" },
    { paymentId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, amountCents: 2500, paidOn: "2026-10-01", method: "whish", reference: "W-1042" },
  ]);
});

test("the operator creates a café, copies its owner's signup link and makes a fresh one", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const sent: unknown[] = [];
  let tries = 0;
  // Fake links for the test only.
  const link = (token: string) => `https://dashboard.example.com/signup#invite=${token}`;
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [] }),
    "POST /api/admin/cafes": async (route) => {
      tries += 1;
      sent.push(route.request().postDataJSON());
      // The first try's answer is lost.
      await (tries === 1
        ? route.abort("failed")
        : route.fulfill({ status: 201, json: { cafe: cafe({ name: "Café Nouveau" }), link: link("fake-invite-token-one"), expiresAt: "2026-10-08T08:00:00.000Z" } }));
    },
    [`POST /api/admin/cafes/${CAFE_ID}/invites`]: async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { cafe: cafe({ name: "Café Nouveau" }), link: link("fake-invite-token-two"), expiresAt: "2026-10-09T08:00:00.000Z" } });
    },
  });
  await page.goto("/admin");
  await expect(page.getByText("No cafés yet.")).toBeVisible();
  const form = page.getByRole("form", { name: "New café" });
  await form.getByLabel("Café name").fill("Café Nouveau");
  await form.getByRole("button", { name: "Create café" }).click();
  await expect(form.getByRole("alert")).toHaveText("Could not reach the server. Check your connection and try again.");
  await form.getByRole("button", { name: "Create café" }).click();

  const card = page.getByRole("region", { name: /Café Nouveau/ });
  const shown = card.getByLabel("Owner signup link for Café Nouveau");
  await expect(shown).toHaveValue(link("fake-invite-token-one"));
  await expect(shown).toBeFocused();
  await expect(shown).toHaveAccessibleDescription("Send it to the café's owner. It works once, until 8 Oct 2026, 08:00, and is shown only now.");
  await expect(form.getByLabel("Café name")).toHaveValue("");
  await card.getByRole("button", { name: "Copy link for Café Nouveau" }).click();
  await expect(card.getByRole("status")).toHaveText("Copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link("fake-invite-token-one"));

  await card.getByRole("button", { name: "New signup link for Café Nouveau" }).click();
  await expect(shown).toHaveValue(link("fake-invite-token-two"));
  await expect(card.getByRole("status")).toHaveText("");
  expect(sent).toEqual([{ cafeId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, name: "Café Nouveau" }, sent[0], {}]);
});

test("makes a new café id after a conflict, and keeps each café's unsent link while another gets one", async ({ page }) => {
  const ids: string[] = [];
  const OTHER_ID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  // Fake links for the test only.
  const link = (token: string) => `https://dashboard.example.com/signup#invite=${token}`;
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    "POST /api/admin/cafes": async (route) => {
      ids.push((route.request().postDataJSON() as { cafeId: string }).cafeId);
      await (ids.length === 1
        ? route.fulfill({
            status: 409,
            json: { code: "CONFLICT", message: "This café was already created with another name. Reload the page to see it, then create any other café as a new one.", retryable: false },
          })
        : route.fulfill({ status: 201, json: { cafe: cafe({ id: OTHER_ID, name: "Café Nouveau" }), link: link("fake-invite-token-new"), expiresAt: "2026-10-08T08:00:00.000Z" } }));
    },
    [`POST /api/admin/cafes/${CAFE_ID}/invites`]: reply(201, { cafe: cafe(), link: link("fake-invite-token-najjar"), expiresAt: "2026-10-08T08:00:00.000Z" }),
  });
  await page.goto("/admin");
  const najjar = page.getByRole("region", { name: /Café Najjar/ });
  await najjar.getByRole("button", { name: "New signup link for Café Najjar" }).click();
  await expect(najjar.getByLabel("Owner signup link for Café Najjar")).toHaveValue(link("fake-invite-token-najjar"));

  const form = page.getByRole("form", { name: "New café" });
  await form.getByLabel("Café name").fill("Café Nouveau");
  await form.getByRole("button", { name: "Create café" }).click();
  await expect(form.getByRole("alert")).toHaveText("This café was already created with another name. Reload the page to see it, then create any other café as a new one.");
  await form.getByRole("button", { name: "Create café" }).click();
  await expect(page.getByRole("region", { name: /Café Nouveau/ }).getByLabel("Owner signup link for Café Nouveau")).toHaveValue(link("fake-invite-token-new"));
  expect(ids).toHaveLength(2);
  expect(ids[1]).not.toBe(ids[0]);
  // Café Najjar's link, not yet sent, is still there.
  await expect(najjar.getByLabel("Owner signup link for Café Najjar")).toHaveValue(link("fake-invite-token-najjar"));
});

test("keeps a café created while another café's link was on its way", async ({ page }) => {
  const OTHER_ID = "2d3e4f5a-6b7c-4d8e-9fa0-1b2c3d4e5f6a";
  // Fake links for the test only.
  const link = (token: string) => `https://dashboard.example.com/signup#invite=${token}`;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    [`POST /api/admin/cafes/${CAFE_ID}/invites`]: async (route) => {
      await held;
      await route.fulfill({ status: 201, json: { cafe: cafe(), link: link("fake-invite-token-najjar"), expiresAt: "2026-10-08T08:00:00.000Z" } });
    },
    "POST /api/admin/cafes": reply(201, { cafe: cafe({ id: OTHER_ID, name: "Café Nouveau" }), link: link("fake-invite-token-new"), expiresAt: "2026-10-08T08:00:00.000Z" }),
  });
  await page.goto("/admin");
  const najjar = page.getByRole("region", { name: /Café Najjar/ });
  await najjar.getByRole("button", { name: "New signup link for Café Najjar" }).click();
  await expect(najjar.getByRole("button", { name: "Making a link… for Café Najjar" })).toBeDisabled();
  const form = page.getByRole("form", { name: "New café" });
  await form.getByLabel("Café name").fill("Café Nouveau");
  await form.getByRole("button", { name: "Create café" }).click();
  const nouveau = page.getByRole("region", { name: /Café Nouveau/ });
  await expect(nouveau.getByLabel("Owner signup link for Café Nouveau")).toHaveValue(link("fake-invite-token-new"));
  release();
  await expect(najjar.getByLabel("Owner signup link for Café Najjar")).toHaveValue(link("fake-invite-token-najjar"));
  await expect(nouveau.getByLabel("Owner signup link for Café Nouveau")).toHaveValue(link("fake-invite-token-new"));
});

test("keeps a plan saved while the café's new link was on its way", async ({ page }) => {
  // Fake links for the test only.
  const link = (token: string) => `https://dashboard.example.com/signup#invite=${token}`;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    [`POST /api/admin/cafes/${CAFE_ID}/invites`]: async (route) => {
      await held;
      // Its copy of the café was read before the plan changed.
      await route.fulfill({ status: 201, json: { cafe: cafe(), link: link("fake-invite-token-najjar"), expiresAt: "2026-10-08T08:00:00.000Z" } });
    },
    [`PATCH /api/admin/cafes/${CAFE_ID}`]: reply(200, cafe({ plan: "suspended" })),
  });
  await page.goto("/admin");
  const card = page.getByRole("region", { name: /Café Najjar/ });
  await card.getByRole("button", { name: "New signup link for Café Najjar" }).click();
  await card.getByLabel("Suspended").check();
  await card.getByRole("button", { name: "Save plan" }).click();
  await expect(card.getByRole("heading", { level: 3, name: /Café Najjar/ })).toContainText("Suspended");
  release();
  await expect(card.getByLabel("Owner signup link for Café Najjar")).toHaveValue(link("fake-invite-token-najjar"));
  await expect(card.getByRole("heading", { level: 3, name: /Café Najjar/ })).toContainText("Suspended");
});

test("sends a payment again with the same id after a failed try, and a new id for the next payment", async ({ page }) => {
  const ids: string[] = [];
  let calls = 0;
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    [`POST /api/admin/cafes/${CAFE_ID}/payments`]: async (route) => {
      calls += 1;
      ids.push((route.request().postDataJSON() as { paymentId: string }).paymentId);
      // The first try's answer is lost.
      await (calls === 1 ? route.abort("failed") : route.fulfill({ status: 201, json: cafe({ paidCents: 2500 }) }));
    },
  });
  await page.goto("/admin");
  const card = page.getByRole("region", { name: /Café Najjar/ });
  await card.getByLabel("Amount (USD)").fill("25");
  await card.getByRole("button", { name: "Record payment" }).click();
  await expect(card.getByRole("alert")).toHaveText("Could not reach the server. Check your connection and try again.");
  await card.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByRole("status")).toContainText("Recorded $25.00 from Café Najjar");
  await card.getByLabel("Amount (USD)").fill("10");
  await card.getByRole("button", { name: "Record payment" }).click();
  await expect.poll(() => ids.length).toBe(3);
  expect(ids[1]).toBe(ids[0]);
  expect(ids[2]).not.toBe(ids[0]);
});

test("shows a refused payment's reason by its field, and a failed sign-out", async ({ page }) => {
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    [`POST /api/admin/cafes/${CAFE_ID}/payments`]: reply(400, {
      code: "VALIDATION_FAILED",
      message: "Use the day the café paid, from 2026 up to today.",
      retryable: false,
      details: [{ path: "paidOn", issue: "Use the day the café paid, from 2026 up to today." }],
    }),
    "POST /api/admin/logout": reply(503, { code: "SERVICE_UNAVAILABLE", message: "The server is restarting. Try again in a minute.", retryable: true }),
  });
  await page.goto("/admin");
  const card = page.getByRole("region", { name: /Café Najjar/ });
  await card.getByLabel("Amount (USD)").fill("25");
  await card.getByLabel("Paid on").fill("2025-06-01");
  await card.getByRole("button", { name: "Record payment" }).click();
  await expect(card.getByLabel("Paid on")).toHaveAttribute("aria-invalid", "true");
  await expect(card.getByLabel("Paid on")).toHaveAccessibleDescription("Use the day the café paid, from 2026 up to today.");
  await expect(card.getByLabel("Amount (USD)")).toHaveValue("25");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("region", { name: "Sign out" }).getByRole("alert")).toHaveText("The server is restarting. Try again in a minute.");
  await expect(page.getByRole("heading", { name: "Cafés" })).toBeVisible();
});

test("returns to the operator sign-in when the session ends while working", async ({ page }) => {
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    [`PATCH /api/admin/cafes/${CAFE_ID}`]: reply(401, { code: "UNAUTHENTICATED", message: "Your operator session has ended. Sign in to the admin screen again.", retryable: false }),
  });
  await page.goto("/admin");
  const card = page.getByRole("region", { name: /Café Najjar/ });
  await card.getByLabel("Active").check();
  await card.getByRole("button", { name: "Save plan" }).click();
  await expect(page.getByRole("heading", { name: "Operator sign-in" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Your operator session has ended. Sign in to the admin screen again.");
});

test("offers to try again when the session cannot be checked", async ({ page }) => {
  let checks = 0;
  await mockApi(page, {
    "GET /api/admin/session": async (route) => {
      checks += 1;
      await (checks === 1 ? route.abort("failed") : route.fulfill({ json: OPERATOR }));
    },
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
  });
  await page.goto("/admin");
  await expect(page.getByRole("alert")).toHaveText("Could not reach the server. Check your connection and try again.");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Cafés" })).toBeVisible();
});

test("refuses an owner on the admin screen with the operator sign-in", async ({ page }) => {
  await mockApi(page, { "GET /api/admin/session": reply(403, { code: "FORBIDDEN", message: "Only the service's operator can do this, from the admin screen.", retryable: false }) });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Operator sign-in" })).toBeVisible();
});
