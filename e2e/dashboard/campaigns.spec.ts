import { expect, test, type Route } from "@playwright/test";
import { SESSION, mockApi, reply } from "./api-mock.js";

const CAFE = { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1, minMarginPercent: 30, winBack: { discount: null, cooldownDays: 30 } };
// Floors at 30% over cost: espresso $0.91, latte $2.60.
const ESPRESSO = { id: "3d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f41", nameAr: "إسبريسو", nameEn: "Espresso", priceCents: 250, costCents: 70, stampsEarned: 1, active: true };
const LATTE = { id: "4e2d2b63-8d66-4b1f-8b6f-1e5d2c3b4a52", nameAr: "لاتيه", nameEn: "Latte", priceCents: 300, costCents: 200, stampsEarned: 1, active: true };

const QUIET = {
  id: "5f3e3c74-9e77-4c2a-9c7a-2f6e3d4c5b63",
  nameAr: "عصر هادئ",
  nameEn: "Quiet afternoons",
  weekdays: [1, 3],
  startsMinute: 900,
  endsMinute: 1020,
  discount: { kind: "percent", value: 20 },
  minMarginPercent: 30,
  orderTypeIds: [ESPRESSO.id],
  createdAt: "2026-10-10T08:00:00.000Z",
  endedAt: null,
};

test("focuses the first part of a new campaign with a problem, the days and the times included", async ({ page }) => {
  let posts = 0;
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, { cafe: CAFE, program: null, orderTypes: [ESPRESSO, LATTE] }),
    "GET /api/campaigns": reply(200, { running: [], ended: [] }),
    "POST /api/campaigns": async (route: Route) => {
      posts += 1;
      await route.fulfill({ status: 201, json: { running: [], ended: [] } });
    },
  });
  await page.goto("/campaigns");
  const form = page.getByRole("form", { name: "New campaign" });
  const start = form.getByRole("button", { name: "Start campaign" });
  await form.getByLabel("Name (English)").fill("Quiet afternoons");
  await form.getByLabel("Name (Arabic)").fill("عصر هادئ");
  // No day picked: the first day takes focus, described by the problem.
  await start.click();
  await expect(form.getByLabel("Monday")).toBeFocused();
  await expect(form.getByLabel("Monday")).toHaveAccessibleDescription("Pick at least one day.");
  // Only the times wrong: the end, which must come after the start, takes focus.
  await form.getByLabel("Monday").check();
  await form.getByLabel("Starts at").fill("17:00");
  await form.getByLabel("Ends at").fill("15:00");
  await form.getByRole("textbox", { name: "Percent off" }).fill("20");
  await form.getByRole("checkbox", { name: /^Espresso/ }).check();
  await start.click();
  await expect(form.getByLabel("Ends at")).toBeFocused();
  // No order type: the first one takes focus.
  await form.getByLabel("Ends at").fill("18:00");
  await form.getByRole("checkbox", { name: /^Espresso/ }).uncheck();
  await start.click();
  await expect(form.getByRole("checkbox", { name: /^Espresso/ })).toBeFocused();
  expect(posts).toBe(0);
});

test("starts a campaign, warning about an order type it takes below the margin floor, then ends it (AC 35)", async ({ page }) => {
  let campaigns: { running: (typeof QUIET)[]; ended: (typeof QUIET | (Omit<typeof QUIET, "endedAt"> & { endedAt: string }))[] } = { running: [], ended: [] };
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, { cafe: CAFE, program: null, orderTypes: [ESPRESSO, LATTE] }),
    "GET /api/campaigns": (route) => route.fulfill({ json: campaigns }),
    "POST /api/campaigns": async (route: Route) => {
      expect(route.request().postDataJSON()).toEqual({
        nameEn: "Quiet afternoons",
        nameAr: "عصر هادئ",
        weekdays: [1, 3],
        startsMinute: 900,
        endsMinute: 1020,
        discount: { kind: "percent", value: 20 },
        orderTypeIds: [ESPRESSO.id],
      });
      campaigns = { running: [QUIET], ended: [] };
      await route.fulfill({ status: 201, json: campaigns });
    },
    [`POST /api/campaigns/${QUIET.id}/end`]: async (route: Route) => {
      campaigns = { running: [], ended: [{ ...QUIET, endedAt: "2026-10-10T09:00:00.000Z" }] };
      await route.fulfill({ json: campaigns });
    },
  });
  await page.goto("/campaigns");
  await expect(page.getByText("No campaigns running.")).toBeVisible();
  const form = page.getByRole("form", { name: "New campaign" });
  await form.getByLabel("Name (English)").fill("Quiet afternoons");
  await form.getByLabel("Name (Arabic)").fill("عصر هادئ");
  await form.getByLabel("Monday").check();
  await form.getByLabel("Wednesday").check();
  await form.getByLabel("Starts at").fill("15:00");
  await form.getByLabel("Ends at").fill("17:00");
  await form.getByRole("textbox", { name: "Percent off" }).fill("20");
  await form.getByRole("checkbox", { name: /^Espresso/ }).check();
  await form.getByRole("checkbox", { name: /^Latte/ }).check();
  // 20% off $3.00 leaves $2.40, under the latte's $2.60 floor.
  await expect(form.getByText("Latte: $3.00, $2.40 with the discount (floor $2.60)")).toBeVisible();
  await expect(form.getByText("Below its floor: lower the discount or leave it out.")).toBeVisible();
  await form.getByRole("checkbox", { name: /^Latte/ }).uncheck();
  await form.getByRole("button", { name: "Start campaign" }).click();
  await expect(page.getByText("Mon, Wed, 15:00 to 17:00: 20% off Espresso")).toBeVisible();

  await page.getByRole("button", { name: "End Quiet afternoons" }).click();
  await page.getByRole("button", { name: "Yes, end Quiet afternoons" }).click();
  await expect(page.getByText("No campaigns running.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ended" })).toBeVisible();
});

test("explains what is missing without calling the server", async ({ page }) => {
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, { cafe: CAFE, program: null, orderTypes: [ESPRESSO] }),
    "GET /api/campaigns": reply(200, { running: [], ended: [] }),
  });
  await page.goto("/campaigns");
  const form = page.getByRole("form", { name: "New campaign" });
  await form.getByLabel("Name (English)").fill("Late");
  await form.getByLabel("Name (Arabic)").fill("متأخر");
  await form.getByLabel("Starts at").fill("17:00");
  await form.getByLabel("Ends at").fill("15:00");
  await form.getByRole("textbox", { name: "Percent off" }).fill("0");
  await form.getByRole("button", { name: "Start campaign" }).click();
  await expect(form.getByText("Pick at least one day.")).toBeVisible();
  await expect(form.getByText("End after the start, on the same day.")).toBeVisible();
  await expect(form.getByText("Enter a whole percentage from 1 to 100.")).toBeVisible();
  await expect(form.getByText("Pick at least one order type.")).toBeVisible();
});

test("starts a fixed-amount campaign running until midnight, and announces each order type the server refuses (AC 35)", async ({ page }) => {
  let attempts = 0;
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, { cafe: CAFE, program: null, orderTypes: [ESPRESSO, LATTE] }),
    "GET /api/campaigns": reply(200, { running: [], ended: [] }),
    "POST /api/campaigns": async (route: Route) => {
      attempts += 1;
      expect(route.request().postDataJSON()).toMatchObject({ weekdays: [5], startsMinute: 1200, endsMinute: 1440, discount: { kind: "amount", value: 50 } });
      // As if the margin changed meanwhile: the server's floors are the ones that count.
      await route.fulfill({
        status: 400,
        json: {
          code: "VALIDATION_FAILED",
          message: "This discount takes some order types below your minimum margin. Lower the discount, or leave those order types out.",
          retryable: false,
          details: [
            { path: "orderTypeIds", issue: "Espresso would sell for $2.00, below its floor of $2.10 (cost $0.70 plus 200%)." },
            { path: "orderTypeIds", issue: "Latte would sell for $2.50, below its floor of $6.00 (cost $2.00 plus 200%)." },
          ],
        },
      });
    },
  });
  await page.goto("/campaigns");
  const form = page.getByRole("form", { name: "New campaign" });
  await form.getByLabel("Name (English)").fill("Late evenings");
  await form.getByLabel("Name (Arabic)").fill("سهرة");
  await form.getByLabel("Friday").check();
  await form.getByLabel("Starts at").fill("20:00");
  await form.getByLabel("Ends at").fill("00:00");
  await form.getByLabel("Amount off each item").check();
  await form.getByRole("textbox", { name: "Amount off (USD)" }).fill("0.50");
  await expect(form.getByText("Espresso: $2.50, $2.00 with the discount (floor $0.91)")).toBeVisible();
  await form.getByRole("checkbox", { name: /^Espresso/ }).check();
  await form.getByRole("checkbox", { name: /^Latte/ }).check();
  // The latte's $2.50 is under its $2.60 floor: flagged, and tied to its checkbox.
  await expect(form.getByRole("checkbox", { name: /^Latte/ })).toHaveAccessibleDescription("Below its floor: lower the discount or leave it out.");
  // Refused on the page, before the server is asked.
  await form.getByRole("button", { name: "Start campaign" }).click();
  await expect(form.getByRole("group", { name: "Order types" })).toHaveAccessibleDescription(/would sell below their floor\. Lower the discount, or leave them out\./);
  // Focus goes to the order type below its floor.
  await expect(form.getByRole("checkbox", { name: /^Latte/ })).toBeFocused();
  expect(attempts).toBe(0);
  await form.getByRole("checkbox", { name: /^Latte/ }).uncheck();
  await form.getByRole("button", { name: "Start campaign" }).click();
  await expect(page.getByRole("alert")).toContainText("below your minimum margin");
  await expect(form.getByRole("group", { name: "Order types" })).toHaveAccessibleDescription(/Espresso would sell for \$2\.00.*Latte would sell for \$2\.50/);
  // Refused by the server while the page's own check passed: the first picked order type is marked and takes focus.
  const espresso = form.getByRole("checkbox", { name: /^Espresso/ });
  await expect(espresso).toHaveAttribute("aria-invalid", "true");
  await expect(espresso).toBeFocused();
  expect(attempts).toBe(1);
});

test("leaves focus in the discount while an order type falls below its floor as it is typed", async ({ page }) => {
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, { cafe: CAFE, program: null, orderTypes: [ESPRESSO, LATTE] }),
    "GET /api/campaigns": reply(200, { running: [], ended: [] }),
    // A send that fails with no field named, so nothing above the order types stays marked.
    "POST /api/campaigns": reply(500, { code: "INTERNAL", message: "Something went wrong on this page. Reload it and try again.", retryable: true }),
  });
  await page.goto("/campaigns");
  const form = page.getByRole("form", { name: "New campaign" });
  await form.getByLabel("Name (English)").fill("Quiet afternoons");
  await form.getByLabel("Name (Arabic)").fill("عصر هادئ");
  await form.getByLabel("Monday").check();
  await form.getByLabel("Starts at").fill("15:00");
  await form.getByLabel("Ends at").fill("17:00");
  await form.getByRole("checkbox", { name: /^Latte/ }).check();
  const discount = form.getByRole("textbox", { name: "Percent off" });
  // 10% keeps the latte above its $2.60 floor, so the page sends it, and the server fails.
  await discount.fill("10");
  await form.getByRole("button", { name: "Start campaign" }).click();
  await expect(page.getByRole("alert")).toContainText("Something went wrong");
  // 20% takes the latte below its floor as it is typed: marked at once, but the keyboard stays where the owner types.
  await discount.clear();
  await discount.pressSequentially("20");
  await expect(form.getByRole("checkbox", { name: /^Latte/ })).toHaveAttribute("aria-invalid", "true");
  await expect(discount).toBeFocused();
  await expect(discount).toHaveValue("20");
});

test("keeps a new campaign being typed when reloading the list fails, and loads only the list again", async ({ page }) => {
  let listLoads = 0;
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, { cafe: CAFE, program: null, orderTypes: [ESPRESSO, LATTE] }),
    "GET /api/campaigns": async (route: Route) => {
      listLoads += 1;
      // The second load, after the stale end below, fails; the third (Try again) works.
      await (listLoads === 2
        ? route.fulfill({ status: 500, json: { code: "INTERNAL", message: "Something went wrong on this page. Reload it and try again.", retryable: true } })
        : route.fulfill({ json: { running: listLoads === 1 ? [QUIET] : [], ended: [] } }));
    },
    // Ended meanwhile on another device: the page reloads its list.
    [`POST /api/campaigns/${QUIET.id}/end`]: reply(409, { code: "CONFLICT", message: "This campaign has already ended. Reload the page to see it.", retryable: false }),
  });
  await page.goto("/campaigns");
  const form = page.getByRole("form", { name: "New campaign" });
  await form.getByLabel("Name (English)").fill("Late evenings");
  await page.getByRole("button", { name: "End Quiet afternoons" }).click();
  await page.getByRole("button", { name: "Yes, end Quiet afternoons" }).click();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  // The form stays, with what was typed.
  await expect(form.getByLabel("Name (English)")).toHaveValue("Late evenings");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("No campaigns running.")).toBeVisible();
  await expect(form.getByLabel("Name (English)")).toHaveValue("Late evenings");
  expect(listLoads).toBe(3);
});

for (const answer of ["the list as it was", "a failure"] as const) {
  test(`keeps a campaign started while the list loads when the load then answers with ${answer}`, async ({ page }) => {
    let releaseList: () => void = () => undefined;
    const listHeld = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    await mockApi(page, {
      "GET /api/auth/session": reply(200, SESSION),
      "GET /api/cafe": reply(200, { cafe: CAFE, program: null, orderTypes: [ESPRESSO, LATTE] }),
      // Answers only after the campaign below is started, from before it was.
      "GET /api/campaigns": async (route: Route) => {
        await listHeld;
        await (answer === "a failure"
          ? route.fulfill({ status: 500, json: { code: "INTERNAL", message: "Something went wrong on this page. Reload it and try again.", retryable: true } })
          : route.fulfill({ json: { running: [], ended: [] } }));
      },
      "POST /api/campaigns": reply(201, { running: [QUIET], ended: [] }),
    });
    await page.goto("/campaigns");
    const form = page.getByRole("form", { name: "New campaign" });
    await form.getByLabel("Name (English)").fill("Quiet afternoons");
    await form.getByLabel("Name (Arabic)").fill("عصر هادئ");
    await form.getByLabel("Monday").check();
    await form.getByLabel("Starts at").fill("15:00");
    await form.getByLabel("Ends at").fill("17:00");
    await form.getByRole("textbox", { name: "Percent off" }).fill("20");
    await form.getByRole("checkbox", { name: /^Espresso/ }).check();
    const started = page.waitForResponse((response) => response.url().endsWith("/api/campaigns") && response.request().method() === "POST");
    await form.getByRole("button", { name: "Start campaign" }).click();
    await started;
    await expect(page.getByRole("button", { name: "End Quiet afternoons" })).toBeVisible();
    const listed = page.waitForResponse((response) => response.url().endsWith("/api/campaigns") && response.request().method() === "GET");
    releaseList();
    await listed;
    // Nothing changes when the old answer is dropped, so there is nothing to wait for but time for it to have rendered.
    await page.waitForTimeout(300);
    await expect(page.getByRole("button", { name: "End Quiet afternoons" })).toBeVisible();
    await expect(page.getByText("No campaigns running.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  });
}

test("starts an ended campaign again from its settings, and picks days with a preset", async ({ page }) => {
  const ended = {
    ...QUIET,
    weekdays: [6, 7],
    endsMinute: 1440,
    discount: { kind: "amount", value: 50 },
    // The second order type was removed since.
    orderTypeIds: [ESPRESSO.id, "6a4f4d85-af88-4d3b-8d8b-3a7f4e5d6c74"],
    endedAt: "2026-10-10T09:00:00.000Z",
  };
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, { cafe: CAFE, program: null, orderTypes: [ESPRESSO, LATTE] }),
    "GET /api/campaigns": reply(200, { running: [], ended: [ended] }),
  });
  await page.goto("/campaigns");
  const form = page.getByRole("form", { name: "New campaign" });
  await expect(form.getByLabel("Name (Arabic)")).toHaveAccessibleDescription("Such as عصر هادئ.");
  // The example is marked as Arabic inside the English hint, so it is spoken and laid out as Arabic.
  await expect(form.getByText("عصر هادئ", { exact: true })).toHaveAttribute("lang", "ar");
  await expect(form.getByText("عصر هادئ", { exact: true })).toHaveAttribute("dir", "rtl");
  // A short visible label, named after the campaign.
  const again = page.getByRole("button", { name: "Start again Quiet afternoons" });
  await expect(again).toHaveText("Start again");
  await again.click();
  await expect(form.getByRole("heading", { name: "New campaign" })).toBeFocused();
  await expect(form.getByLabel("Name (English)")).toHaveValue("Quiet afternoons");
  await expect(form.getByLabel("Name (Arabic)")).toHaveValue("عصر هادئ");
  await expect(form.getByLabel("Saturday")).toBeChecked();
  await expect(form.getByLabel("Sunday")).toBeChecked();
  await expect(form.getByLabel("Monday")).not.toBeChecked();
  await expect(form.getByLabel("Starts at")).toHaveValue("15:00");
  await expect(form.getByLabel("Ends at")).toHaveValue("00:00");
  await expect(form.getByLabel("Amount off each item")).toBeChecked();
  await expect(form.getByRole("textbox", { name: "Amount off (USD)" })).toHaveValue("0.50");
  await expect(form.getByRole("checkbox", { name: /^Espresso/ })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: /^Latte/ })).not.toBeChecked();

  await form.getByRole("button", { name: "Monday to Friday" }).click();
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
    await expect(form.getByLabel(day)).toBeChecked();
  }
  await expect(form.getByLabel("Saturday")).not.toBeChecked();
  await form.getByRole("button", { name: "Every day" }).click();
  await expect(form.getByLabel("Sunday")).toBeChecked();
  await form.getByRole("button", { name: "Saturday and Sunday" }).click();
  await expect(form.getByLabel("Monday")).not.toBeChecked();
  await expect(form.getByLabel("Saturday")).toBeChecked();
});

test("asks before leaving a new campaign being typed, and no more once it is started", async ({ page }) => {
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, { cafe: CAFE, program: null, orderTypes: [ESPRESSO, LATTE] }),
    "GET /api/campaigns": reply(200, { running: [], ended: [] }),
    "POST /api/campaigns": reply(201, { running: [QUIET], ended: [] }),
    "GET /api/review-queue": reply(200, { items: [], nextCursor: null }),
    "GET /api/feedback": reply(200, { items: [], unread: 0, nextCursor: null }),
  });
  await page.goto("/campaigns");
  const form = page.getByRole("form", { name: "New campaign" });
  await form.getByLabel("Name (English)").fill("Quiet afternoons");
  const asked: string[] = [];
  page.on("dialog", (dialog) => {
    asked.push(dialog.type());
    void dialog.dismiss();
  });
  // Dismissed: the page stays, with what was typed.
  await page.getByRole("navigation").getByRole("link", { name: "Inbox" }).click();
  await expect.poll(() => asked).toEqual(["beforeunload"]);
  await expect(form.getByLabel("Name (English)")).toHaveValue("Quiet afternoons");

  await form.getByLabel("Name (Arabic)").fill("عصر هادئ");
  await form.getByRole("button", { name: "Monday to Friday" }).click();
  await form.getByRole("textbox", { name: "Percent off" }).fill("20");
  await form.getByRole("checkbox", { name: /^Espresso/ }).check();
  await form.getByRole("button", { name: "Start campaign" }).click();
  await expect(page.getByRole("button", { name: "End Quiet afternoons" })).toBeVisible();
  await page.getByRole("navigation").getByRole("link", { name: "Review" }).click();
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  expect(asked).toEqual(["beforeunload"]);
});
