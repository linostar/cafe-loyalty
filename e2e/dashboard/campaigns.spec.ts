import { expect, test, type Route } from "@playwright/test";
import { SESSION, mockApi, reply } from "./api-mock.js";

const CAFE = { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1, minMarginPercent: 30 };
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
