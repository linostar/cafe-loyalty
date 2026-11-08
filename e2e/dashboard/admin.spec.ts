import { readFile } from "node:fs/promises";
import { ICON_PNG_PATH } from "@cafe-loyalty/ui";
import { expect, test, type Route } from "@playwright/test";
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
  owners: [],
  openInvites: [],
  ...overrides,
});
const OWNER = { email: "owner@example.com", signedUpAt: "2026-10-02T08:00:00.000Z" };
const OPEN = { id: "e01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", createdAt: "2026-10-01T08:00:00.000Z", expiresAt: "2026-10-08T08:00:00.000Z" };
/** A time while OPEN is still open: the page drops a link once it expires. */
const WHILE_OPEN = new Date("2026-10-02T09:00:00.000Z");
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
          payments: [{ id: "d01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", amountCents: 2500, paidOn: "2026-10-01", method: "whish", reference: "W-1042", recordedAt: "2026-10-01T09:00:00.000Z", voided: null }],
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
  await expect(page.getByRole("listitem").filter({ hasText: "Café Najjar" })).toContainText("No owner yet");
  await page.getByRole("link", { name: "Café Najjar" }).click();
  await expect(page).toHaveURL(CAFE_PAGE);

  const card = page.getByRole("region", { name: /Café Najjar/ });
  await expect(card.getByRole("button", { name: "Save plan" })).toBeDisabled();
  // A disabled Save plan says why, on screen and in its description; a new choice enables it and the reason goes (AC 10).
  await expect(card.getByRole("button", { name: "Save plan" })).toHaveAccessibleDescription("Choose another plan to save.");
  await expect(card.getByText("Choose another plan to save.")).toBeVisible();
  // The day paid is a date picker, today's by default (the browser's own day), offering the days the server takes.
  const today = new Date().toLocaleDateString("en-CA");
  await expect(card.getByLabel("Paid on")).toHaveAttribute("type", "date");
  await expect(card.getByLabel("Paid on")).toHaveValue(today);
  await expect(card.getByLabel("Paid on")).toHaveAttribute("min", "2026-01-01");
  await expect(card.getByLabel("Paid on")).toHaveAttribute("max", today);
  await card.getByRole("group", { name: "Plan of Café Najjar" }).getByLabel("Suspended").check();
  await expect(card.getByRole("button", { name: "Save plan" })).toBeEnabled();
  await expect(card.getByText("Choose another plan to save.")).toHaveCount(0);
  await expect(card.getByText("Its signup page enrols no one; its counter still records and syncs visits.")).toBeVisible();
  // Suspending asks again (A1): the safe choice has focus, and Escape steps back without saving.
  await card.getByRole("button", { name: "Save plan" }).click();
  await expect(card.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(card.getByRole("button", { name: "Yes, suspend Café Najjar" })).toHaveAccessibleDescription("Its signup page enrols no one; its counter still records and syncs visits.");
  await page.keyboard.press("Escape");
  await expect(card.getByRole("button", { name: "Save plan of Café Najjar" })).toBeFocused();
  await card.getByRole("button", { name: "Save plan" }).click();
  await card.getByRole("button", { name: "Yes, suspend Café Najjar" }).click();
  await expect(page.getByRole("status").first()).toHaveText("Café Najjar is now on the suspended plan.");
  await expect(card.getByRole("heading", { level: 2, name: /Café Najjar/ })).toBeFocused();
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
  await expect(page.getByRole("status").first()).toHaveText("Recorded $25.00 from Café Najjar, paid by Whish on 1 Oct 2026.");
  // The day paid, then when it was recorded (the Recorded column, with its time), then the amount, method and reference.
  await expect(card.getByRole("table", { name: "Latest payments of Café Najjar" }).getByRole("row", { name: /1 Oct 2026 1 Oct 2026, 09:00 \$25\.00 Whish W-1042/ })).toBeVisible();
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
  // Copied again: the same words in a fresh node, so a screen reader says them again (A5).
  const said = await page.getByRole("status").locator("span").elementHandle();
  await page.getByRole("button", { name: "Copy link for Café Nouveau" }).click();
  await expect.poll(() => said.evaluate((node) => node.isConnected)).toBe(false);
  await expect(page.getByRole("status")).toHaveText("Copied.");
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
  await expect(page.getByRole("status").filter({ hasText: "Copied." })).toHaveCount(1);
  await page.getByRole("button", { name: "New signup link for Café Najjar" }).click();
  await expect(shown).toHaveValue(link("fake-invite-token-2"));
  // A fresh link has not been copied yet.
  await expect(page.getByRole("status").filter({ hasText: "Copied." })).toHaveCount(0);
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
  await card.getByRole("button", { name: "Yes, suspend Café Najjar" }).click();
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
  await expect(page.getByRole("status").first()).toContainText("Recorded $25.00 from Café Najjar");
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
  // A cleared picker is caught in the form, before sending.
  await card.getByLabel("Paid on").fill("");
  await card.getByRole("button", { name: "Record payment" }).click();
  await expect(card.getByLabel("Paid on")).toHaveAccessibleDescription("Pick the day the café paid.");
  await expect(card.getByLabel("Paid on")).toBeFocused();
  // Picking a day takes its message away at once, before any send; cleared again for the next check.
  await card.getByLabel("Paid on").fill("2026-10-01");
  await expect(card.getByLabel("Paid on")).not.toHaveAttribute("aria-invalid", "true");
  await expect(card.getByText("Pick the day the café paid.")).toHaveCount(0);
  await card.getByLabel("Paid on").fill("");
  // The form's own messages follow a language switch (kept untranslated until shown).
  await card.getByLabel("Amount (USD)").fill("0");
  await card.getByRole("button", { name: "Record payment" }).click();
  await page.getByRole("button", { name: "العربية" }).click();
  await expect(card.getByLabel("تاريخ الدفع")).toHaveAccessibleDescription("اختر اليوم الذي دفع فيه المقهى.");
  await expect(card.getByLabel("المبلغ (بالدولار)")).toHaveAccessibleDescription("أدخل مبلغاً بالدولار أكبر من 0، مثل 25 أو 25.00.");
  await page.getByRole("button", { name: "English" }).click();
  await card.getByLabel("Amount (USD)").fill("25");
  // A day outside the picker's range still goes to the server, whose reason shows by the field (AC 10).
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

test("voids a payment with its reason: it stays listed, struck through and out of the total, and focus stays on its row", async ({ page }) => {
  const payment = (id: string, amountCents: number, paidOn: string, voided: { at: string; reason: string } | null = null) => ({
    id,
    amountCents,
    paidOn,
    method: "cash",
    reference: null,
    recordedAt: `${paidOn}T09:00:00.000Z`,
    voided,
  });
  const wrong = "d01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01";
  const right = "d01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f02";
  const sent: unknown[] = [];
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe({ paidCents: 3500, payments: [payment(right, 1000, "2026-10-02"), payment(wrong, 2500, "2026-10-01")] })] }),
    [`POST /api/admin/cafes/${CAFE_ID}/payments/${wrong}/void`]: async (route) => {
      const body = route.request().postDataJSON() as { reason: string };
      sent.push(body);
      await (body.reason.trim() === ""
        ? route.fulfill({
            status: 400,
            json: { code: "VALIDATION_FAILED", message: "Some fields are missing or not valid. Check them and try again.", retryable: false, details: [{ path: "reason", issue: "Enter why the payment is voided." }] },
          })
        : route.fulfill({
            json: cafe({ paidCents: 1000, payments: [payment(right, 1000, "2026-10-02"), payment(wrong, 2500, "2026-10-01", { at: "2026-10-16T10:00:00.000Z", reason: body.reason })] }),
          }));
    },
  });
  await page.goto(CAFE_PAGE);
  await expect(page.locator(".page-intro")).toContainText("Paid in all: $35.00.");
  const voidWrong = page.getByRole("button", { name: "Void the payment of $25.00 paid on 1 Oct 2026" });
  await expect(voidWrong).toHaveText("Void");

  // Cancelled: nothing sent, focus back on the row's button.
  await voidWrong.click();
  const reason = page.getByLabel("Reason");
  await expect(reason).toBeFocused();
  await expect(page.getByRole("heading", { name: "Void the payment of $25.00 paid on 1 Oct 2026" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(reason).toHaveCount(0);
  await expect(voidWrong).toBeFocused();
  // Escape steps back too, from the field, as ConfirmButton's second step does.
  await voidWrong.click();
  await reason.fill("Not yet");
  await page.keyboard.press("Escape");
  await expect(reason).toHaveCount(0);
  await expect(voidWrong).toBeFocused();

  // No reason, or only spaces: refused by the server, by its field in the page's own words (no browser bubble), the form
  // kept and the field focused so its message is read.
  await voidWrong.click();
  await page.getByRole("button", { name: "Void payment" }).click();
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(reason).toHaveAccessibleDescription(/Enter why the payment is voided\.$/);
  await expect(reason).toBeFocused();
  await reason.fill("   ");
  await page.getByRole("button", { name: "Void payment" }).click();
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(reason).toHaveAccessibleDescription(/Enter why the payment is voided\.$/);
  await expect(reason).toBeFocused();
  await reason.fill("Typed the wrong amount");
  await page.getByRole("button", { name: "Void payment" }).click();

  await expect(page.getByRole("status").first()).toHaveText("Voided the payment of $25.00 paid on 1 Oct 2026.");
  const row = page.getByRole("row").filter({ hasText: "$25.00" });
  await expect(row.getByRole("cell").last()).toHaveText("Voided Typed the wrong amount");
  await expect(row.getByRole("button")).toHaveCount(0);
  // Struck through, and still readable: its day, amount, method and reference stay.
  // The day paid, then when it was recorded, with its time (in the operator's zone, UTC here).
  await expect(row.getByRole("cell")).toHaveText(["1 Oct 2026", "1 Oct 2026, 09:00", "$25.00", "Cash", "—", "Voided Typed the wrong amount"]);
  await expect(row.locator("time")).toHaveAttribute("datetime", "2026-10-01T09:00:00.000Z");
  expect(await row.getByRole("cell").nth(2).evaluate((cell) => getComputedStyle(cell).textDecorationLine)).toBe("line-through");
  await expect(row.locator(".payment-status")).toBeFocused();
  await expect(page.locator(".page-intro")).toContainText("Paid in all: $10.00.");
  await expect(page.getByRole("button", { name: "Void the payment of $10.00 paid on 2 Oct 2026" })).toBeEnabled();
  expect(sent).toEqual([{ reason: "" }, { reason: "   " }, { reason: "Typed the wrong amount" }]);
});

test("says when another session voided the payment first, keeping its reason, and when the payment is not the café's", async ({ page }) => {
  const payment = (id: string, voided: { at: string; reason: string } | null = null) => ({
    id,
    amountCents: 2500,
    paidOn: "2026-10-01",
    method: "cash",
    reference: null,
    recordedAt: "2026-10-01T09:00:00.000Z",
    voided,
  });
  const first = "d01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01";
  const gone = "d01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f02";
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe({ paidCents: 5000, payments: [payment(first), payment(gone)] })] }),
    [`POST /api/admin/cafes/${CAFE_ID}/payments/${first}/void`]: reply(200, cafe({ paidCents: 2500, payments: [payment(first, { at: "2026-10-16T09:00:00.000Z", reason: "Paid twice" }), payment(gone)] })),
    [`POST /api/admin/cafes/${CAFE_ID}/payments/${gone}/void`]: reply(404, { code: "NOT_FOUND", message: "This payment is not in this café's list. Reload the page.", retryable: false }),
  });
  await page.goto(CAFE_PAGE);
  const voidButtons = page.getByRole("button", { name: "Void the payment of $25.00 paid on 1 Oct 2026" });
  await voidButtons.first().click();
  await page.getByLabel("Reason").fill("Typed the wrong amount");
  await page.getByRole("button", { name: "Void payment" }).click();
  // The first void and its reason stay: the page says so, rather than that this reason was saved.
  await expect(page.getByRole("status").first()).toHaveText("The payment of $25.00 paid on 1 Oct 2026 was already voided: Paid twice");
  await expect(page.getByRole("row").filter({ hasText: "Paid twice" })).toHaveCount(1);

  await voidButtons.last().click();
  await page.getByLabel("Reason").fill("Duplicate");
  await page.getByRole("button", { name: "Void payment" }).click();
  await expect(page.locator(".void-payment").getByRole("alert")).toHaveText("This payment is not in this café's list. Reload the page.");
  await expect(page.getByLabel("Reason")).toHaveValue("Duplicate");
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
  // Operators choose longer passwords than owners.
  await expect(page.getByText("At least 16 characters.")).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute("minlength", "16");
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

test("leaves without asking once a confirmed suspend is saved, but asks while it is only picked", async ({ page }) => {
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    [`PATCH /api/admin/cafes/${CAFE_ID}`]: reply(200, cafe({ plan: "suspended" })),
  });
  await page.goto(CAFE_PAGE);
  const card = page.getByRole("region", { name: /Café Najjar/ });
  const asked: string[] = [];
  page.on("dialog", (dialog) => {
    asked.push(dialog.type());
    void dialog.dismiss();
  });
  await card.getByLabel("Suspended").check();
  await page.getByRole("link", { name: "All cafés" }).click();
  await expect.poll(() => asked).toEqual(["beforeunload"]);
  await card.getByRole("button", { name: "Save plan" }).click();
  await card.getByRole("button", { name: "Yes, suspend Café Najjar" }).click();
  await expect(card.getByRole("heading", { level: 2, name: /Café Najjar/ })).toContainText("Suspended");
  await page.getByRole("link", { name: "All cafés" }).click();
  await expect(page.getByRole("heading", { name: "Cafés" })).toBeVisible();
  expect(asked).toEqual(["beforeunload"]);
});

test("shows the café's owner and open signup links, and revokes the open ones after asking (A4)", async ({ page }) => {
  let revoked = 0;
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe({ owners: [OWNER], openInvites: [OPEN] })] }),
    [`POST /api/admin/cafes/${CAFE_ID}/invites/revoke`]: async (route) => {
      expect(route.request().postDataJSON()).toEqual({});
      revoked += 1;
      await route.fulfill({ json: cafe({ owners: [OWNER] }) });
    },
  });
  await page.clock.install({ time: WHILE_OPEN });
  await page.goto(CAFE_PAGE);
  const card = page.getByRole("region", { name: /Café Najjar/ });
  await expect(card.getByRole("heading", { level: 3, name: "Owner and signup links of Café Najjar" })).toBeVisible();
  await expect(card.getByText("owner@example.com")).toBeVisible();
  await expect(card.getByText("Signed up 2 Oct 2026")).toBeVisible();
  await expect(card.getByText("Made 1 Oct 2026, 08:00, works until 8 Oct 2026, 08:00.")).toBeVisible();

  await card.getByRole("button", { name: "Revoke open links of Café Najjar" }).click();
  await expect(card.getByRole("button", { name: "Cancel" })).toBeFocused();
  await card.getByRole("button", { name: "Cancel" }).click();
  expect(revoked).toBe(0);
  await card.getByRole("button", { name: "Revoke open links of Café Najjar" }).click();
  await card.getByRole("button", { name: "Yes, revoke the open links of Café Najjar" }).click();
  await expect(page.getByRole("status").first()).toHaveText("Closed the open signup links of Café Najjar.");
  await expect(card.getByText("No open signup links.")).toBeVisible();
  await expect(card.getByRole("button", { name: /^Revoke open links/ })).toHaveCount(0);
  await expect(card.getByRole("heading", { level: 2, name: /Café Najjar/ })).toBeFocused();
  expect(revoked).toBe(1);
});

test("asks before a new signup link for a café that already has an owner, and lists the new link as open", async ({ page }) => {
  let made = 0;
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe({ owners: [OWNER] })] }),
    [`POST /api/admin/cafes/${CAFE_ID}/invites`]: async (route) => {
      made += 1;
      await route.fulfill({ status: 201, json: invite("fake-invite-token-second-owner", { owners: [OWNER], openInvites: [OPEN] }) });
    },
  });
  await page.clock.install({ time: WHILE_OPEN });
  await page.goto(CAFE_PAGE);
  const card = page.getByRole("region", { name: /Café Najjar/ });
  await expect(card.getByText("Café Najjar already has an owner. A new link lets one more person sign up as its owner.")).toBeVisible();
  await expect(card.getByText("No open signup links.")).toBeVisible();
  await card.getByRole("button", { name: "New signup link for Café Najjar" }).click();
  await expect(card.getByRole("button", { name: "Cancel" })).toHaveAccessibleDescription("Café Najjar already has an owner. A new link lets one more person sign up as its owner.");
  expect(made).toBe(0);
  await card.getByRole("button", { name: "Yes, make a link for another owner of Café Najjar" }).click();
  const shown = card.getByLabel("Owner signup link for Café Najjar");
  await expect(shown).toHaveValue(link("fake-invite-token-second-owner"));
  await expect(shown).toBeFocused();
  await expect(card.getByText("Made 1 Oct 2026, 08:00, works until 8 Oct 2026, 08:00.")).toBeVisible();
  expect(made).toBe(1);
});

test("drops a signup link from the open ones when it expires while the page is open", async ({ page }) => {
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe({ owners: [OWNER], openInvites: [OPEN] })] }),
  });
  await page.clock.install({ time: new Date(Date.parse(OPEN.expiresAt) - 60_000) });
  await page.goto(CAFE_PAGE);
  const card = page.getByRole("region", { name: /Café Najjar/ });
  await expect(card.getByText("Made 1 Oct 2026, 08:00, works until 8 Oct 2026, 08:00.")).toBeVisible();
  // The device clock is set forwards past the expiry (no timer fires): within a minute the link has gone.
  await page.clock.setSystemTime(Date.parse(OPEN.expiresAt) + 60 * 60_000);
  await expect(card.getByText("Made 1 Oct 2026, 08:00, works until 8 Oct 2026, 08:00.")).toBeVisible();
  await page.clock.fastForward("01:00");
  await expect(card.getByText("No open signup links.")).toBeVisible();
  await expect(card.getByRole("button", { name: /^Revoke open links/ })).toHaveCount(0);
});

test("keeps a payment recorded while a plan was being saved, and a plan saved while a revoke was on its way", async ({ page }) => {
  const releases: (() => void)[] = [];
  const hold = () =>
    new Promise<void>((resolve) => {
      releases.push(resolve);
    });
  const open = { ...OPEN, expiresAt: "2099-10-08T08:00:00.000Z" };
  const paid = { id: "d01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01", amountCents: 2500, paidOn: "2026-10-01", method: "cash", reference: null, recordedAt: "2026-10-01T09:00:00.000Z", voided: null };
  let plan = "pilot";
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe({ openInvites: [open] })] }),
    // Each answer's copy of the café was read before the other save.
    [`PATCH /api/admin/cafes/${CAFE_ID}`]: async (route) => {
      await hold();
      plan = (route.request().postDataJSON() as { plan: string }).plan;
      await route.fulfill({ json: cafe({ plan, openInvites: [open] }) });
    },
    [`POST /api/admin/cafes/${CAFE_ID}/payments`]: reply(201, cafe({ paidCents: 2500, payments: [paid], openInvites: [open] })),
    [`POST /api/admin/cafes/${CAFE_ID}/invites/revoke`]: async (route) => {
      await hold();
      // Read while the café was still active, before the plan save below.
      await route.fulfill({ json: cafe({ plan: "active", paidCents: 2500, payments: [paid] }) });
    },
  });
  await page.goto(CAFE_PAGE);
  const card = page.getByRole("region", { name: /Café Najjar/ });

  // A plan's answer, after a payment's: the payment and its total stay.
  await card.getByLabel("Active").check();
  await card.getByRole("button", { name: "Save plan" }).click();
  await card.getByLabel("Amount (USD)").fill("25");
  await card.getByLabel("Paid on").fill("2026-10-01");
  await card.getByRole("button", { name: "Record payment" }).click();
  await expect(card.getByText("Paid in all: $25.00.")).toBeVisible();
  releases.shift()?.();
  await expect(card.getByRole("heading", { level: 2, name: /Café Najjar/ })).toContainText("Active");
  await expect(card.getByText("Paid in all: $25.00.")).toBeVisible();
  await expect(card.getByRole("table", { name: "Latest payments of Café Najjar" }).getByRole("row")).toHaveCount(2);

  // A revoke's answer, after a plan's: the plan stays.
  await card.getByRole("button", { name: "Revoke open links of Café Najjar" }).click();
  await card.getByRole("button", { name: "Yes, revoke the open links of Café Najjar" }).click();
  await card.getByLabel("Pilot").check();
  await card.getByRole("button", { name: "Save plan" }).click();
  await expect.poll(() => releases.length).toBe(2);
  // Answer the plan first, then the revoke.
  releases.pop()?.();
  await expect(card.getByRole("heading", { level: 2, name: /Café Najjar/ })).toContainText("Pilot");
  releases.pop()?.();
  await expect(card.getByText("No open signup links.")).toBeVisible();
  await expect(card.getByRole("heading", { level: 2, name: /Café Najjar/ })).toContainText("Pilot");
  await expect(card.getByText("Paid in all: $25.00.")).toBeVisible();
});

test("keeps a link made while a plan was being saved, whose answer came later", async ({ page }) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const open = { ...OPEN, expiresAt: "2099-10-08T08:00:00.000Z" };
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    [`POST /api/admin/cafes/${CAFE_ID}/invites`]: reply(201, invite("fake-invite-token-meanwhile", { openInvites: [open] })),
    [`PATCH /api/admin/cafes/${CAFE_ID}`]: async (route) => {
      await held;
      // Its copy of the café was read before the link was made.
      await route.fulfill({ json: cafe({ plan: "active" }) });
    },
  });
  await page.goto(CAFE_PAGE);
  const card = page.getByRole("region", { name: /Café Najjar/ });
  await card.getByLabel("Active").check();
  await card.getByRole("button", { name: "Save plan" }).click();
  await card.getByRole("button", { name: "New signup link for Café Najjar" }).click();
  await expect(card.getByRole("listitem").filter({ hasText: "works until 8 Oct 2099" })).toHaveCount(1);
  release();
  await expect(card.getByRole("heading", { level: 2, name: /Café Najjar/ })).toContainText("Active");
  await expect(card.getByRole("listitem").filter({ hasText: "works until 8 Oct 2099" })).toHaveCount(1);
  await expect(card.getByLabel("Owner signup link for Café Najjar")).toHaveValue(link("fake-invite-token-meanwhile"));
});

test("holds Revoke open links while a new link is on its way, so the link made is never dropped", async ({ page }) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let revoked = 0;
  // Open for good, so the test needs no fake clock.
  const open = { ...OPEN, expiresAt: "2099-10-08T08:00:00.000Z" };
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe({ openInvites: [open] })] }),
    [`POST /api/admin/cafes/${CAFE_ID}/invites`]: async (route) => {
      await held;
      await route.fulfill({ status: 201, json: invite("fake-invite-token-held", { openInvites: [open, { ...open, id: "e01c1a52-7c55-4a0e-9a5e-0d4c1b2a3f02" }] }) });
    },
    [`POST /api/admin/cafes/${CAFE_ID}/invites/revoke`]: async (route) => {
      revoked += 1;
      await route.fulfill({ json: cafe() });
    },
  });
  await page.goto(CAFE_PAGE);
  const card = page.getByRole("region", { name: /Café Najjar/ });
  await card.getByRole("button", { name: "New signup link for Café Najjar" }).click();
  const revoke = card.getByRole("button", { name: "Revoke open links of Café Najjar" });
  await expect(revoke).toHaveAttribute("aria-disabled", "true");
  // Forced: Playwright waits for an aria-disabled button to be enabled, and the press must land while the link is on its way.
  await revoke.click({ force: true });
  await expect(card.getByRole("button", { name: /^Yes, revoke/ })).toHaveCount(0);
  release();
  await expect(card.getByLabel("Owner signup link for Café Najjar")).toHaveValue(link("fake-invite-token-held"));
  await expect(card.getByRole("listitem").filter({ hasText: "Made 1 Oct 2026" })).toHaveCount(2);
  expect(revoked).toBe(0);
});

test("finds a café by name and plan in the list, saying how many are shown (A3)", async ({ page }) => {
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, {
      cafes: [
        cafe({ owners: [OWNER] }),
        cafe({ id: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1e", name: "Study Corner", plan: "active" }),
        cafe({ id: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1f", name: "Najjar Roastery", plan: "suspended" }),
      ],
    }),
  });
  await page.goto("/admin");
  const rows = page.getByRole("main").getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(page.getByRole("status")).toHaveText("Showing 3 of 3 cafés");
  await expect(rows.filter({ hasText: "Café Najjar" })).not.toContainText("No owner yet");
  await expect(rows.filter({ hasText: "Study Corner" })).toContainText("No owner yet");

  await page.getByRole("searchbox", { name: "Search by name" }).fill("  najJAR ");
  await expect(rows).toHaveText([/Café Najjar/, /Najjar Roastery/]);
  await expect(page.getByRole("status")).toHaveText("Showing 2 of 3 cafés");
  await page.getByRole("combobox", { name: "Plan" }).selectOption({ label: "Suspended" });
  await expect(rows).toHaveText([/Najjar Roastery/]);
  await expect(page.getByRole("status")).toHaveText("Showing 1 of 3 cafés");
  await page.getByRole("searchbox", { name: "Search by name" }).fill("corner");
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("No café matches the search and plan chosen.")).toBeVisible();
  await page.getByRole("combobox", { name: "Plan" }).selectOption({ label: "All plans" });
  await expect(rows).toHaveText([/Study Corner/]);
});

test("picks the café's stamp shape, which the card preview then shows", async ({ page }) => {
  const sent: unknown[] = [];
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    [`PATCH /api/admin/cafes/${CAFE_ID}`]: async (route) => {
      const body = route.request().postDataJSON() as { stampShape: string };
      sent.push(body);
      await route.fulfill({ json: cafe({ stampShape: body.stampShape }) });
    },
  });
  await page.goto(CAFE_PAGE);
  // A café from before shapes (or a server that sends none) draws circles.
  const shapes = page.getByRole("form", { name: "Stamp shape" });
  await expect(shapes.getByRole("radio", { name: "Circle" })).toBeChecked();
  await shapes.getByRole("radio", { name: "Cup" }).check();
  await shapes.getByRole("button", { name: "Save shape" }).click();
  await expect(shapes.getByRole("status")).toHaveText("Saved. Cards in wallets show the new shape within a few minutes.");
  expect(sent).toEqual([{ stampShape: "cup" }]);
  await expect(page.getByRole("form", { name: "Card and name" }).locator(".card-preview-stamps .is-filled")).toHaveCount(4);
});

test("names the café and picks its card colours, checked for contrast, with a live preview, then uploads and removes its logo", async ({ page }) => {
  const HASH = "ab".repeat(32);
  const png = await readFile(ICON_PNG_PATH);
  const sent: { method: string; body: unknown }[] = [];
  const record = (route: Route) => {
    sent.push({ method: route.request().method(), body: route.request().postDataJSON() });
  };
  await mockApi(page, {
    "GET /api/admin/session": reply(200, OPERATOR),
    "GET /api/admin/cafes": reply(200, { cafes: [cafe()] }),
    [`PATCH /api/admin/cafes/${CAFE_ID}`]: async (route) => {
      record(route);
      const body = route.request().postDataJSON() as { name: string; cardColors: Record<string, string> };
      await route.fulfill({ json: cafe({ name: body.name, cardColors: body.cardColors }) });
    },
    [`PUT /api/admin/cafes/${CAFE_ID}/logo`]: async (route) => {
      record(route);
      await route.fulfill({ json: cafe({ name: "Café Nour", logoHash: HASH }) });
    },
    [`DELETE /api/admin/cafes/${CAFE_ID}/logo`]: async (route) => {
      record(route);
      await route.fulfill({ json: cafe({ name: "Café Nour", logoHash: null }) });
    },
    [`GET /api/logos/${HASH}.png`]: (route) => route.fulfill({ status: 200, contentType: "image/png", body: png }),
  });
  await page.goto(CAFE_PAGE);
  const form = page.getByRole("form", { name: "Card and name" });
  const face = form.locator(".card-preview-face");
  // Today's espresso until the operator picks colours.
  await expect(face).toHaveCSS("background-color", "rgb(74, 44, 42)");

  await form.getByLabel("Café name").fill("Café Nour");
  // Text nearly the background's colour: refused here, by its field, before anything is sent.
  await form.getByLabel("Text colour").fill("#55302e");
  await form.getByRole("button", { name: "Save card" }).click();
  // Read with the rule, then its own message.
  await expect(form.getByLabel("Text colour")).toHaveAccessibleDescription(
    /^Text and labels need at least 4\.5 to 1 contrast .* Pick a text colour that stands out more from the background: at least 4\.5 to 1\.$/,
  );
  await expect(form.getByLabel("Text colour")).toBeFocused();
  expect(sent).toEqual([]);
  await form.getByLabel("Text colour").fill("#ffffff");
  await expect(form.getByLabel("Text colour")).not.toHaveAttribute("aria-invalid", "true");
  await form.getByLabel("Background colour").fill("#1f5a85");
  // The preview follows each pick: name, background and text as customers will see them.
  await expect(face).toHaveCSS("background-color", "rgb(31, 90, 133)");
  await expect(face).toContainText("Café Nour");
  await form.getByRole("button", { name: "Save card" }).click();
  await expect(form.getByText("Saved.")).toBeVisible();
  expect(sent).toEqual([{ method: "PATCH", body: { name: "Café Nour", cardColors: { background: "#1f5a85", foreground: "#ffffff", label: "#ebd6be" } } }]);
  await expect(page.getByRole("heading", { level: 2 })).toContainText("Café Nour");

  const logo = page.getByRole("form", { name: "Logo of Café Nour" });
  // Not a PNG or JPEG: said by the field, nothing sent.
  await logo.getByLabel("Logo").setInputFiles({ name: "logo.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
  await logo.getByRole("button", { name: "Upload logo" }).click();
  await expect(logo.getByLabel("Logo")).toHaveAccessibleDescription(/Upload the logo as a PNG or JPEG image\.$/);
  expect(sent).toHaveLength(1);

  await logo.getByLabel("Logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
  await logo.getByRole("button", { name: "Upload logo" }).click();
  await expect(logo.getByText("Saved. Cards in wallets show it within a few minutes.")).toBeVisible();
  expect(sent[1]).toEqual({ method: "PUT", body: { image: png.toString("base64") } });
  await expect(face.locator("img")).toHaveAttribute("src", `/api/logos/${HASH}.png`);
  await logo.getByRole("button", { name: "Remove logo" }).click();
  await expect(logo.getByText("Logo removed.")).toBeVisible();
  expect(sent[2]?.method).toBe("DELETE");
  await expect(face.locator("img")).toHaveCount(0);
  await expect(logo.getByRole("button", { name: "Remove logo" })).toHaveCount(0);
  await expect(logo.getByLabel("Logo")).toBeFocused();
});
