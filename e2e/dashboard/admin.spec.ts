import { expect, test } from "@playwright/test";
import { UNAUTHENTICATED, mockApi, reply } from "./api-mock.js";

test.use({ timezoneId: "UTC" });

// Fake operator, cafés and links for the test only.
const OPERATOR = { operator: { id: "c01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", email: "operator@example.com" } };
const CAFE_ID = "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d";
const CAFE_PAGE = `/admin/cafes/${CAFE_ID}`;
const cafe = (overrides: Record<string, unknown> = {}) => ({
  id: CAFE_ID,
  name: "Café Najjar",
  plan: "pilot",
  createdAt: "2026-09-01T08:00:00.000Z",
  paidCents: 0,
  payments: [],
  ...overrides,
});
const link = (token: string) => `https://dashboard.example.com/signup#invite=${token}`;
const invite = (token: string, overrides: Record<string, unknown> = {}) => ({ cafe: cafe(overrides), link: link(token), expiresAt: "2026-10-08T08:00:00.000Z" });

test("the operator signs in, opens a café, suspends it, records a payment and signs out from the menu (AC 39)", async ({ page }) => {
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
    "POST /api/admin/logout": async (route) => {
      signedIn = false;
      await route.fulfill({ status: 204 });
    },
  });
  await page.goto("/admin");
  await page.getByLabel("Email").fill("operator@example.com");
  await page.getByLabel("Password").fill("fake-operator-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Cafés" })).toBeVisible();
  // The list holds the cafés and the way to a new one, nothing else.
  await expect(page.getByRole("link", { name: "New café" })).toHaveAttribute("href", "/admin/cafes/new");
  await expect(page.getByRole("button", { name: "Save plan" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden();
  await expect(page.getByRole("listitem").filter({ hasText: "Café Najjar" })).toContainText("Pilot");
  await page.getByRole("link", { name: "Café Najjar" }).click();
  await expect(page).toHaveURL(CAFE_PAGE);

  const card = page.getByRole("region", { name: /Café Najjar/ });
  await expect(card.getByRole("button", { name: "Save plan" })).toBeDisabled();
  await card.getByRole("group", { name: "Plan of Café Najjar" }).getByLabel("Suspended").check();
  await expect(card.getByText("Its signup page enrols no one; its counter still records and syncs visits.")).toBeVisible();
  await card.getByRole("button", { name: "Save plan" }).click();
  await expect(page.getByRole("status")).toHaveText("Café Najjar is now on the suspended plan.");
  await expect(card.getByRole("heading", { level: 2, name: /Café Najjar/ })).toContainText("Suspended");

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

  await page.getByRole("button", { name: "Profile: operator@example.com" }).click();
  await expect(page.getByRole("link", { name: "Change password" })).toHaveAttribute("href", "/admin/password");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Operator sign-in" })).toBeVisible();
  await expect(page.getByText("You signed out on every device.")).toBeVisible();
  expect(sent).toEqual([
    { email: "operator@example.com", password: "fake-operator-password" },
    { plan: "suspended" },
    { paymentId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, amountCents: 2500, paidOn: "2026-10-01", method: "whish", reference: "W-1042" },
  ]);
});

test("says so when there are no cafés yet, and shows the list for an unknown admin page", async ({ page }) => {
  await mockApi(page, { "GET /api/admin/session": reply(200, OPERATOR), "GET /api/admin/cafes": reply(200, { cafes: [] }) });
  await page.goto("/admin/nothing-here");
  await expect(page.getByRole("heading", { name: "Cafés" })).toBeVisible();
  await expect(page.getByText("No cafés yet.")).toBeVisible();
});

test("says a café no longer exists, with the way back to the list", async ({ page }) => {
  await mockApi(page, { "GET /api/admin/session": reply(200, OPERATOR), "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }) });
  await page.goto("/admin/cafes/9b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d");
  await expect(page.getByRole("alert")).toHaveText("There is no café at this address.");
  await page.getByRole("link", { name: "All cafés" }).click();
  await expect(page.getByRole("heading", { name: "Cafés" })).toBeVisible();
});

test("asks for the operator sign-in on every admin page", async ({ page }) => {
  await mockApi(page, { "GET /api/admin/session": reply(401, UNAUTHENTICATED) });
  for (const path of ["/admin/cafes/new", CAFE_PAGE, "/admin/password"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Operator sign-in" })).toBeVisible();
  }
});

test("the operator creates a café, copies its owner's signup link and opens its page", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const sent: unknown[] = [];
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [] }),
    "POST /api/admin/cafes": async (route) => {
      sent.push(route.request().postDataJSON());
      // The first try's answer is lost.
      await (sent.length === 1 ? route.abort("failed") : route.fulfill({ status: 201, json: invite("fake-invite-token-one", { name: "Café Nouveau" }) }));
    },
  });
  await page.goto("/admin");
  await page.getByRole("link", { name: "New café" }).click();
  await expect(page).toHaveURL("/admin/cafes/new");
  const form = page.getByRole("form", { name: "New café" });
  await form.getByLabel("Café name").fill("Café Nouveau");
  await form.getByRole("button", { name: "Create café" }).click();
  await expect(form.getByRole("alert")).toHaveText("Could not reach the server. Check your connection and try again.");
  await form.getByRole("button", { name: "Create café" }).click();

  const shown = page.getByLabel("Owner signup link for Café Nouveau");
  await expect(shown).toHaveValue(link("fake-invite-token-one"));
  await expect(shown).toBeFocused();
  await expect(shown).toHaveAccessibleDescription("Send it to the café's owner. It works once, until 8 Oct 2026, 08:00, and is shown only now.");
  await expect(form.getByLabel("Café name")).toHaveValue("");
  await page.getByRole("button", { name: "Copy link for Café Nouveau" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link("fake-invite-token-one"));
  expect(sent).toEqual([{ cafeId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, name: "Café Nouveau" }, sent[0]]);
  await expect(page.getByRole("link", { name: "Open Café Nouveau" })).toHaveAttribute("href", CAFE_PAGE);
});

test("makes a new café id after a conflict", async ({ page }) => {
  const ids: string[] = [];
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "POST /api/admin/cafes": async (route) => {
      ids.push((route.request().postDataJSON() as { cafeId: string }).cafeId);
      await (ids.length === 1
        ? route.fulfill({
            status: 409,
            json: { code: "CONFLICT", message: "This café was already created with another name. Reload the page to see it, then create any other café as a new one.", retryable: false },
          })
        : route.fulfill({ status: 201, json: invite("fake-invite-token-new", { name: "Café Nouveau" }) }));
    },
  });
  await page.goto("/admin/cafes/new");
  const form = page.getByRole("form", { name: "New café" });
  await form.getByLabel("Café name").fill("Café Nouveau");
  await form.getByRole("button", { name: "Create café" }).click();
  await expect(form.getByRole("alert")).toHaveText("This café was already created with another name. Reload the page to see it, then create any other café as a new one.");
  await form.getByRole("button", { name: "Create café" }).click();
  await expect(page.getByLabel("Owner signup link for Café Nouveau")).toHaveValue(link("fake-invite-token-new"));
  expect(ids).toHaveLength(2);
  expect(ids[1]).not.toBe(ids[0]);
});

test("makes fresh signup links on a café's page, each shown once and copied afresh", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let made = 0;
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    [`POST /api/admin/cafes/${CAFE_ID}/invites`]: async (route) => {
      expect(route.request().postDataJSON()).toEqual({});
      made += 1;
      await route.fulfill({ status: 201, json: invite(`fake-invite-token-${String(made)}`) });
    },
  });
  await page.goto(CAFE_PAGE);
  await page.getByRole("button", { name: "New signup link for Café Najjar" }).click();
  const shown = page.getByLabel("Owner signup link for Café Najjar");
  await expect(shown).toHaveValue(link("fake-invite-token-1"));
  await page.getByRole("button", { name: "Copy link for Café Najjar" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied.");
  await page.getByRole("button", { name: "New signup link for Café Najjar" }).click();
  await expect(shown).toHaveValue(link("fake-invite-token-2"));
  // A fresh link has not been copied yet.
  await expect(page.getByRole("status")).toHaveText("");
});

test("keeps a plan saved while the café's new link was on its way", async ({ page }) => {
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
      await route.fulfill({ status: 201, json: invite("fake-invite-token-najjar") });
    },
    [`PATCH /api/admin/cafes/${CAFE_ID}`]: reply(200, cafe({ plan: "suspended" })),
  });
  await page.goto(CAFE_PAGE);
  const card = page.getByRole("region", { name: /Café Najjar/ });
  await card.getByRole("button", { name: "New signup link for Café Najjar" }).click();
  await card.getByLabel("Suspended").check();
  await card.getByRole("button", { name: "Save plan" }).click();
  await expect(card.getByRole("heading", { level: 2, name: /Café Najjar/ })).toContainText("Suspended");
  release();
  await expect(card.getByLabel("Owner signup link for Café Najjar")).toHaveValue(link("fake-invite-token-najjar"));
  await expect(card.getByRole("heading", { level: 2, name: /Café Najjar/ })).toContainText("Suspended");
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
  await page.goto(CAFE_PAGE);
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

test("shows a refused payment's reason by its field, and a failed sign-out in the menu", async ({ page }) => {
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
  await page.goto(CAFE_PAGE);
  const card = page.getByRole("region", { name: /Café Najjar/ });
  await card.getByLabel("Amount (USD)").fill("25");
  await card.getByLabel("Paid on").fill("2025-06-01");
  await card.getByRole("button", { name: "Record payment" }).click();
  await expect(card.getByLabel("Paid on")).toHaveAttribute("aria-invalid", "true");
  await expect(card.getByLabel("Paid on")).toHaveAccessibleDescription("Use the day the café paid, from 2026 up to today.");
  await expect(card.getByLabel("Amount (USD)")).toHaveValue("25");
  await page.getByRole("button", { name: "Profile: operator@example.com" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("banner").getByRole("alert")).toHaveText("The server is restarting. Try again in a minute.");
  await expect(page.getByRole("heading", { level: 2, name: /Café Najjar/ })).toBeVisible();
});

test("changes the operator's password and returns to the operator sign-in", async ({ page }) => {
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "POST /api/admin/password": async (route) => {
      expect(route.request().postDataJSON()).toEqual({ currentPassword: "fake-operator-password", newPassword: "a brand new password" });
      await route.fulfill({ status: 204 });
    },
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Profile: operator@example.com" }).click();
  await page.getByRole("link", { name: "Change password" }).click();
  await expect(page).toHaveURL("/admin/password");
  await expect(page.getByRole("heading", { level: 2, name: "Change password" })).toBeVisible();
  await expect(page.getByText("Signed in as operator@example.com")).toBeVisible();
  await page.getByLabel("Current password", { exact: true }).fill("fake-operator-password");
  await page.getByLabel("New password", { exact: true }).fill("a brand new password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("heading", { name: "Operator sign-in" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Your password is changed. Sign in with the new password.");
});

test("shows a wrong current password by its field", async ({ page }) => {
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "POST /api/admin/password": reply(400, {
      code: "VALIDATION_FAILED",
      message: "The current password is wrong. Check it and try again.",
      retryable: false,
      details: [{ path: "currentPassword", issue: "The current password is wrong. Check it and try again." }],
    }),
  });
  await page.goto("/admin/password");
  await page.getByLabel("Current password", { exact: true }).fill("not the password");
  await page.getByLabel("New password", { exact: true }).fill("a brand new password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByLabel("Current password", { exact: true })).toHaveAccessibleDescription("The current password is wrong. Check it and try again.");
});

test("returns to the operator sign-in when the session ends while working", async ({ page }) => {
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    [`PATCH /api/admin/cafes/${CAFE_ID}`]: reply(401, { code: "UNAUTHENTICATED", message: "Your operator session has ended. Sign in to the admin screen again.", retryable: false }),
  });
  await page.goto(CAFE_PAGE);
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
