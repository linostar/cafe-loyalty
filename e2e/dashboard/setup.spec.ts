import { readFile } from "node:fs/promises";
import { ICON_PNG_PATH } from "@cafe-loyalty/ui";
import { expect, test, type Route } from "@playwright/test";
import { SESSION, UNAUTHENTICATED, mockApi, reply } from "./api-mock.js";

const CAFE = { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1, minMarginPercent: 30, winBack: { discount: null, cooldownDays: 30 } };
const ESPRESSO = { id: "3d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f41", nameAr: "إسبريسو", nameEn: "Espresso", priceCents: 250, costCents: 70, stampsEarned: 1, active: true };
const PROGRAM = { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" };

const json = (route: Route): unknown => route.request().postDataJSON();

const JOIN = { joinUrl: "https://card.example.test/join/0123456789abcdef0123456789abcdef" };

test("shows the printable signup QR and replaces the code after confirming", async ({ page }) => {
  const replaced = { joinUrl: "https://card.example.test/join/fedcba9876543210fedcba9876543210" };
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, { cafe: CAFE, program: PROGRAM, orderTypes: [] }),
    "GET /api/cafe/join": reply(200, JOIN),
    "POST /api/cafe/join/rotate": reply(200, replaced),
  });
  await page.goto("/cafe");
  const qr = page.getByRole("img", { name: "QR code customers scan to get a loyalty card" });
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((image: HTMLImageElement) => image.naturalWidth > 0)).toBe(true);
  await expect(page.getByText(JOIN.joinUrl)).toBeVisible();
  await page.getByRole("button", { name: "Replace code" }).click();
  await page.getByRole("button", { name: "Yes, replace the code" }).click();
  await expect(page.getByText(replaced.joinUrl)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Customer signup QR" })).toBeFocused();
});

test("saves the program, then adds and edits an order type", async ({ page }) => {
  let setup: { cafe: typeof CAFE; program: typeof PROGRAM | null; orderTypes: (typeof ESPRESSO)[] } = { cafe: CAFE, program: null, orderTypes: [] };
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": (route) => route.fulfill({ json: setup }),
    "GET /api/cafe/join": reply(200, JOIN),
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
  await expect(page.getByRole("form", { name: "Loyalty program" }).getByRole("status")).toHaveText("Saved.");

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
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, { cafe: CAFE, program: PROGRAM, orderTypes: [] }),
    "GET /api/cafe/join": reply(200, JOIN),
  });
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
  await expect(page.getByRole("form", { name: "Add a barista" }).getByRole("status")).toContainText("Saved.");

  await page.getByRole("button", { name: "Remove Rami" }).click();
  // Focus goes to the safe choice, Escape backs out, and after confirming it lands on the section heading.
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Remove Rami" })).toBeFocused();
  await page.getByRole("button", { name: "Remove Rami" }).click();
  await page.getByRole("button", { name: "Yes, remove Rami" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Staff" })).toBeFocused();
  // Removed baristas are kept out of the way, in a closed group.
  await page.getByText("Removed (1)").click();
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
    "GET /api/devices": reply(200, { devices: [counter], pairingCodes: [], counterUrl: "https://counter.example.test" }),
    "POST /api/devices/pairing-codes": async (route) => {
      expect(json(route)).toEqual({ deviceName: "Back bar" });
      await route.fulfill({
        status: 201,
        json: {
          id: "8d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f44",
          deviceName: "Back bar",
          code: "ABCD-EFGH-JKMN",
          pairingUrl: "https://counter.example.test/pair#code=ABCDEFGHJKMN",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        },
      });
    },
    [`POST /api/devices/${counter.id}/revoke`]: reply(200, { devices: [{ ...counter, revoked: true }], pairingCodes: [], counterUrl: "https://counter.example.test" }),
  });
  await page.goto("/devices");
  // Where a paired phone finds the counter again: its address, as a link and a QR, with no code.
  const openCounter = page.getByRole("region", { name: "Open the counter" });
  await expect(openCounter.getByRole("link", { name: "counter.example.test" })).toHaveAttribute("href", "https://counter.example.test");
  await expect(openCounter.getByRole("img", { name: "QR code that opens the counter" })).toBeVisible();
  await page.getByLabel("Phone name").fill("Back bar");
  await page.getByRole("button", { name: "Create pairing code" }).click();
  await expect(page.getByRole("heading", { name: "Pair Back bar" })).toBeFocused();
  await expect(page.getByText("ABCD-EFGH-JKMN")).toBeVisible();
  const qr = page.getByRole("img", { name: "QR code to pair Back bar" });
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((image: HTMLImageElement) => image.naturalWidth > 0 && image.src.startsWith("data:image/svg+xml"))).toBe(true);

  await page.getByRole("button", { name: "Remove Front counter" }).click();
  await page.getByRole("button", { name: "Yes, remove Front counter" }).click();
  await expect(page.getByRole("status")).toHaveText("Front counter is removed. It stops working the next time it connects; anything it had not sent waits under Review.");
});

test("returns to sign-in when the session ends on a page", async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(200, SESSION), "GET /api/staff": reply(401, UNAUTHENTICATED) });
  await page.goto("/staff");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Your session has ended. Sign in again.");
});

test("saves the welcome-back offer, checking the discount and the cool-down first (AC 36)", async ({ page }) => {
  let setup = { cafe: CAFE, program: PROGRAM, orderTypes: [ESPRESSO] };
  const saved: unknown[] = [];
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": (route) => route.fulfill({ json: setup }),
    "GET /api/cafe/join": reply(200, JOIN),
    "PUT /api/cafe/win-back": async (route) => {
      const body = json(route) as typeof CAFE.winBack;
      saved.push(body);
      setup = { ...setup, cafe: { ...CAFE, winBack: body } };
      await route.fulfill({ json: setup });
    },
  });
  await page.goto("/cafe");
  const form = page.getByRole("form", { name: "Welcome-back offer" });
  await expect(form.getByRole("radio", { name: "No offer" })).toBeChecked();
  await form.getByRole("radio", { name: "Percent off" }).check();
  await form.getByLabel("Percentage").fill("150");
  await form.getByLabel("Days before the same card can get it again").fill("7");
  await form.getByRole("button", { name: "Save welcome-back offer" }).click();
  await expect(form.getByText("Enter a whole percentage from 1 to 100.")).toBeVisible();
  await expect(form.getByText("Enter a whole number of days from 14 to 365.")).toBeVisible();
  expect(saved).toEqual([]);
  await form.getByLabel("Percentage").fill("15");
  await form.getByLabel("Days before the same card can get it again").fill("45");
  await form.getByRole("button", { name: "Save welcome-back offer" }).click();
  await expect.poll(() => saved).toEqual([{ discount: { kind: "percent", value: 15 }, cooldownDays: 45 }]);
  // Turning it off sends no discount.
  await form.getByRole("radio", { name: "No offer" }).check();
  await form.getByRole("button", { name: "Save welcome-back offer" }).click();
  await expect.poll(() => saved).toHaveLength(2);
  expect(saved[1]).toEqual({ discount: null, cooldownDays: 45 });
});

test("saves the minimum margin campaigns must keep", async ({ page }) => {
  let setup = { cafe: CAFE, program: PROGRAM, orderTypes: [ESPRESSO] };
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": (route) => route.fulfill({ json: setup }),
    "GET /api/cafe/join": reply(200, JOIN),
    "PATCH /api/cafe": async (route) => {
      expect(json(route)).toEqual({ minMarginPercent: 35 });
      setup = { ...setup, cafe: { ...CAFE, minMarginPercent: 35 } };
      await route.fulfill({ json: setup });
    },
  });
  await page.goto("/cafe");
  const margin = page.getByRole("form", { name: "Minimum margin" });
  await expect(margin.getByLabel("Minimum margin over cost (%)")).toHaveValue("30");
  await margin.getByLabel("Minimum margin over cost (%)").fill("thirty");
  await margin.getByRole("button", { name: "Save margin" }).press("Enter");
  await expect(margin.getByText("Enter a whole percentage from 0 to 1000, such as 30.")).toBeVisible();
  // The field with the problem takes focus, so its message is read with it (WCAG 3.3.1).
  await expect(margin.getByLabel("Minimum margin over cost (%)")).toBeFocused();
  await margin.getByLabel("Minimum margin over cost (%)").fill("35");
  await margin.getByRole("button", { name: "Save margin" }).press("Enter");
  // Next to the form that saved, and the keyboard is still on its button (WCAG 2.4.3).
  await expect(margin.getByRole("status")).toHaveText("Saved.");
  await expect(margin.getByRole("button", { name: "Save margin" })).toBeFocused();
  // Typing again clears the old confirmation.
  await margin.getByLabel("Minimum margin over cost (%)").fill("36");
  await expect(margin.getByRole("status")).toHaveText("");
});

test("shows the card in the café's colours and uploads the owner's logo, which the preview then shows, then removes it", async ({ page }) => {
  const HASH = "cd".repeat(32);
  const png = await readFile(ICON_PNG_PATH);
  const colours = { background: "#1f5a85", foreground: "#ffffff", label: "#e5eff7" };
  let setup = { cafe: { ...CAFE, cardColors: colours, logoHash: null as string | null }, program: PROGRAM, orderTypes: [ESPRESSO] };
  const uploads: unknown[] = [];
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": (route) => route.fulfill({ json: setup }),
    "GET /api/cafe/join": reply(200, JOIN),
    "PUT /api/cafe/logo": async (route) => {
      uploads.push(json(route));
      setup = { ...setup, cafe: { ...setup.cafe, logoHash: HASH } };
      await route.fulfill({ json: setup });
    },
    "DELETE /api/cafe/logo": async (route) => {
      uploads.push("removed");
      setup = { ...setup, cafe: { ...setup.cafe, logoHash: null } };
      await route.fulfill({ json: setup });
    },
    [`GET /api/logos/${HASH}.png`]: (route) => route.fulfill({ status: 200, contentType: "image/png", body: png }),
  });
  await page.goto("/cafe");
  const section = page.getByRole("region", { name: "Card" });
  // The colours the operator set; the owner sees them, and is told who changes them.
  await expect(section.locator(".card-preview-face")).toHaveCSS("background-color", "rgb(31, 90, 133)");
  await expect(section.getByText("The card's colours are set by the service's operator: ask them to change them.")).toBeVisible();
  const logo = section.getByRole("form", { name: `Logo of ${CAFE.name}` });
  await logo.getByLabel("Logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
  await logo.getByRole("button", { name: "Upload logo" }).click();
  await expect(logo.getByRole("status")).toHaveText("Saved. Cards in wallets show it within a few minutes.");
  expect(uploads).toEqual([{ image: png.toString("base64") }]);
  await expect(section.locator(".card-preview-face img")).toHaveAttribute("src", `/api/logos/${HASH}.png`);

  await logo.getByRole("button", { name: "Remove logo" }).click();
  await expect(logo.getByRole("status")).toHaveText("Logo removed.");
  expect(uploads).toEqual([{ image: png.toString("base64") }, "removed"]);
  await expect(section.locator(".card-preview-face img")).toHaveCount(0);
  await expect(logo.getByRole("button", { name: "Remove logo" })).toHaveCount(0);
  // The button went with the logo: the keyboard is on the file field, not dropped to the page (WCAG 2.4.3).
  await expect(logo.getByLabel("Logo")).toBeFocused();
});

test("picks the shape the card's stamps are drawn in, which the preview then shows", async ({ page }) => {
  let setup = { cafe: { ...CAFE, stampShape: "circle" }, program: PROGRAM, orderTypes: [ESPRESSO] };
  const sent: unknown[] = [];
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": (route) => route.fulfill({ json: setup }),
    "GET /api/cafe/join": reply(200, JOIN),
    "PUT /api/cafe/stamp-shape": async (route) => {
      const body = json(route) as { stampShape: string };
      sent.push(body);
      setup = { ...setup, cafe: { ...setup.cafe, stampShape: body.stampShape } };
      await route.fulfill({ json: setup });
    },
  });
  await page.goto("/cafe");
  const section = page.getByRole("region", { name: "Card" });
  // Sample stamps, 4 of 9, said in words to screen readers.
  await expect(section.locator(".card-preview-stamps li")).toHaveCount(9);
  await expect(section.locator(".card-preview-stamps .is-filled")).toHaveCount(4);
  await expect(section.getByText("4 of 9 stamps")).toHaveClass("visually-hidden");
  const form = section.getByRole("form", { name: "Stamp shape" });
  const shapes = form.getByRole("group", { name: "Stamp shape" });
  for (const name of ["Circle", "Cup", "Steaming cup", "Plate", "Coffee bean", "Ice cream", "Cake", "Burger"]) {
    await expect(shapes.getByRole("radio", { name, exact: true })).toBeVisible();
  }
  await expect(shapes.getByRole("radio")).toHaveCount(8);
  await expect(shapes.getByRole("radio", { name: "Circle" })).toBeChecked();
  // The 9 sample stamps in rows as the cards have them: 5, then 4.
  const tops = await section.locator(".card-preview-stamps li").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
  expect([...new Set(tops)].map((top) => tops.filter((other) => other === top).length)).toEqual([5, 4]);
  const circle = await section.locator(".card-preview-stamps .is-filled path").first().getAttribute("d");
  await shapes.getByRole("radio", { name: "Ice cream" }).check();
  await form.getByRole("button", { name: "Save shape" }).click();
  await expect(form.getByRole("status")).toHaveText("Saved. Cards in wallets show the new shape within a few minutes.");
  expect(sent).toEqual([{ stampShape: "icecream" }]);
  await expect(section.locator(".card-preview-stamps .is-filled path").first()).not.toHaveAttribute("d", circle ?? "");
  await expect(shapes.getByRole("radio", { name: "Ice cream" })).toBeChecked();
});

test("says nothing is saved when the field changed while its save was on its way", async ({ page }) => {
  let setup = { cafe: CAFE, program: PROGRAM, orderTypes: [ESPRESSO] };
  let held = false;
  let answer: () => void = () => undefined;
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": (route) => route.fulfill({ json: setup }),
    "GET /api/cafe/join": reply(200, JOIN),
    "PATCH /api/cafe": async (route) => {
      // Held until the test lets it go, so the edit below lands while it is pending.
      await new Promise<void>((resolve) => {
        answer = resolve;
        held = true;
      });
      setup = { ...setup, cafe: { ...CAFE, minMarginPercent: 35 } };
      await route.fulfill({ json: setup });
    },
  });
  await page.goto("/cafe");
  const margin = page.getByRole("form", { name: "Minimum margin" });
  const field = margin.getByLabel("Minimum margin over cost (%)");
  await field.fill("35");
  await margin.getByRole("button", { name: "Save margin" }).click();
  await expect(margin.getByRole("button", { name: "Saving…" })).toHaveAttribute("aria-disabled", "true");
  await field.fill("36");
  await expect.poll(() => held).toBe(true);
  answer();
  await expect(margin.getByRole("button", { name: "Save margin" })).not.toHaveAttribute("aria-disabled");
  // 36 was never sent: "Saved." would claim it was.
  await expect(margin.getByRole("status")).toHaveText("");
  await expect(field).toHaveValue("36");
});

test("checks the café's own fields itself, in the page's language, and focuses the first with a problem", async ({ page }) => {
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, { cafe: CAFE, program: null, orderTypes: [] }),
    "GET /api/cafe/join": reply(200, JOIN),
  });
  await page.goto("/cafe");
  const add = page.getByRole("form", { name: "Add an order type" });
  // No browser validation bubbles: the form is sent to the page's own checks.
  await expect(add).toHaveAttribute("novalidate", "");
  await add.getByLabel("Price (USD)").fill("abc");
  await add.getByRole("button", { name: "Add order type" }).click();
  await expect(add.getByText("Enter a price in dollars up to 1,000,000, such as 2.50.")).toBeVisible();
  await expect(add.getByLabel("Price (USD)")).toBeFocused();
});

test("sends a form once however often it is pressed while its request is on its way", async ({ page }) => {
  const rami = { id: "5d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f42", name: "Rami", revoked: false, createdAt: "2026-10-08T12:00:00.000Z" };
  let posts = 0;
  let answer: () => void = () => undefined;
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/staff": reply(200, { staff: [] }),
    "POST /api/staff": async (route) => {
      posts += 1;
      // Held until the test lets it go, so the presses below land while it is pending.
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      await route.fulfill({ status: 201, json: { staff: [rami] } });
    },
  });
  await page.goto("/staff");
  const form = page.getByRole("form", { name: "Add a barista" });
  await form.getByLabel("Name").fill("Rami");
  await form.getByLabel("PIN").fill("482913");
  const add = form.getByRole("button", { name: /^Add/ });
  await add.click();
  // Pending: marked unavailable but still focusable, so the keyboard stays on it.
  await expect(add).toHaveAttribute("aria-disabled", "true");
  // Forced: Playwright would otherwise wait for an aria-disabled button to become available, as a person would not.
  await add.click({ force: true });
  await page.keyboard.press("Enter");
  await expect(add).toBeFocused();
  expect(posts).toBe(1);
  answer();
  await expect(form.getByRole("status")).toContainText("Saved.");
  expect(posts).toBe(1);
});

test("leaves focus on the language switch when a shown problem changes language", async ({ page }) => {
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/cafe": reply(200, { cafe: CAFE, program: PROGRAM, orderTypes: [] }),
    "GET /api/cafe/join": reply(200, JOIN),
  });
  await page.goto("/cafe");
  const margin = page.getByRole("form", { name: "Minimum margin" });
  await margin.getByLabel("Minimum margin over cost (%)").fill("thirty");
  await margin.getByRole("button", { name: "Save margin" }).click();
  await expect(margin.getByLabel("Minimum margin over cost (%)")).toBeFocused();
  await page.getByRole("button", { name: "العربية" }).click();
  // The problem follows the language (it is not kept translated), and focus stays where the owner put it.
  await expect(page.getByText("أدخل نسبة مئوية صحيحة من 0 إلى 1000، مثل 30.")).toBeVisible();
  await expect(page.getByRole("button", { name: "English" })).toBeFocused();
});

/** A café's setup as the server keeps it (D1, D22), changed by the mocked writes below. */
function setupServer(start: { program: typeof PROGRAM | null; setupFinishedAt: string | null; signupQrPrintedAt?: string | null }) {
  let setup = { cafe: { ...CAFE, setupFinishedAt: start.setupFinishedAt, signupQrPrintedAt: start.signupQrPrintedAt ?? null }, program: start.program, orderTypes: [] as (typeof ESPRESSO)[] };
  const milestones: string[] = [];
  const milestone = (field: "setupFinishedAt" | "signupQrPrintedAt") => async (route: Route) => {
    // A milestone carries no data, only the JSON body every write must have.
    expect(json(route)).toEqual({});
    milestones.push(field);
    setup = { ...setup, cafe: { ...setup.cafe, [field]: setup.cafe[field] ?? "2026-10-20T09:00:00.000Z" } };
    await route.fulfill({ json: setup });
  };
  return {
    milestones,
    routes: {
      "GET /api/auth/session": reply(200, SESSION),
      "GET /api/cafe": (route: Route) => route.fulfill({ json: setup }),
      "GET /api/cafe/join": reply(200, JOIN),
      "GET /api/review-queue": reply(200, { items: [], nextCursor: null }),
      "GET /api/feedback": reply(200, { items: [], unread: 0, nextCursor: null }),
      "GET /api/results": reply(200, {
        month: "2026-10",
        current: true,
        months: ["2026-10"],
        memberVisits: 0,
        customersWonBack: 0,
        quietHourVisits: 0,
        rewardRedemptions: 0,
        offers: { winBack: { visits: 0, costCents: 0, revenueCents: 0 }, quietHour: { visits: 0, costCents: 0, revenueCents: 0 } },
      }),
      "PUT /api/cafe/program": async (route: Route) => {
        // What the wizard's form sent, as typed.
        expect(json(route)).toEqual(PROGRAM);
        setup = { ...setup, program: PROGRAM };
        await route.fulfill({ json: setup });
      },
      "POST /api/cafe/setup/finish": milestone("setupFinishedAt"),
      "POST /api/cafe/join/printed": milestone("signupQrPrintedAt"),
    },
  };
}

/** Headless Chromium shows no print dialog: printing here only fires `beforeprint`, as a browser does before its dialog. */
const fakePrint = () => {
  window.print = () => {
    window.dispatchEvent(new Event("beforeprint"));
  };
};

const RAMI = { id: "5d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f42", name: "Rami", revoked: false, createdAt: "2026-10-08T12:00:00.000Z" };
const NO_DEVICES = { devices: [], pairingCodes: [], counterUrl: "https://counter.example.test" };

test.describe("setup wizard (D1)", () => {
  test("takes a new café through the five steps by keyboard, each done in place or skipped, and is not shown again", async ({ page }) => {
    const server = setupServer({ program: null, setupFinishedAt: null });
    let staff = [] as (typeof RAMI)[];
    await page.addInitScript(fakePrint);
    await mockApi(page, {
      ...server.routes,
      "GET /api/staff": (route) => route.fulfill({ json: { staff } }),
      "POST /api/staff": async (route) => {
        staff = [RAMI];
        await route.fulfill({ status: 201, json: { staff } });
      },
      "GET /api/devices": reply(200, NO_DEVICES),
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2, name: "Set up your café" })).toBeVisible();

    // Step 1, in place: the Café page's own program form.
    await expect(page.getByRole("heading", { level: 3, name: "Step 1 of 5 Your loyalty program" })).toBeVisible();
    await page.getByLabel("Stamps for a reward").fill("9");
    await page.getByLabel("Reward (English)").fill("Free coffee");
    await page.getByLabel("Reward (Arabic)").fill("قهوة مجانية");
    await page.getByRole("button", { name: "Save program" }).press("Enter");
    await expect(page.getByRole("form", { name: "Loyalty program" }).getByRole("status")).toHaveText("Saved.");
    await page.getByRole("button", { name: "Next" }).press("Enter");

    // Step 2, skipped; focus is on each step's heading, so a screen reader says where the owner is.
    await expect(page.getByRole("heading", { level: 3, name: "Step 2 of 5 Your first order type" })).toBeFocused();
    await page.getByRole("button", { name: "Skip this step" }).press("Enter");

    await expect(page.getByRole("heading", { level: 3, name: "Step 3 of 5 Your first barista" })).toBeFocused();
    await page.getByLabel("Name").fill("Rami");
    await page.getByLabel("PIN").fill("482913");
    await page.getByRole("button", { name: "Add barista" }).press("Enter");
    await expect(page.getByRole("form", { name: "Add a barista" }).getByRole("status")).toContainText("Saved.");
    await page.getByRole("button", { name: "Next" }).press("Enter");

    await expect(page.getByRole("heading", { level: 3, name: "Step 4 of 5 Your counter phone" })).toBeFocused();
    await expect(page.getByRole("form", { name: "Pair a counter phone" })).toBeVisible();
    await page.getByRole("button", { name: "Skip this step" }).press("Enter");

    await expect(page.getByRole("heading", { level: 3, name: "Step 5 of 5 Your signup QR" })).toBeFocused();
    await expect(page.getByRole("img", { name: "QR code customers scan to get a loyalty card" })).toHaveCount(2);
    await page.getByRole("button", { name: "Print the Arabic sheet" }).press("Enter");
    await expect.poll(() => server.milestones).toEqual(["signupQrPrintedAt"]);
    await expect(page.getByText("Done", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Finish setup" }).press("Enter");

    // Finished: Home, focused on its heading, with what is left on the checklist.
    await expect(page.getByRole("heading", { level: 2, name: SESSION.cafe.name })).toBeFocused();
    expect(server.milestones).toEqual(["signupQrPrintedAt", "setupFinishedAt"]);
    const checklist = page.getByRole("region", { name: "Finish setting up" });
    await expect(checklist).toContainText("3 of 5 done.");
    await expect(checklist.getByRole("link")).toHaveText(["Add an order type", "Pair a phone"]);

    // Kept on the server: this device, or any other, opens Home without the wizard.
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: SESSION.cafe.name })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Set up your café" })).toHaveCount(0);
  });

  test("records skipping the rest, and Home lists every step left with a link to do it (D22)", async ({ page }) => {
    const server = setupServer({ program: null, setupFinishedAt: null });
    await mockApi(page, { ...server.routes, "GET /api/staff": reply(200, { staff: [] }), "GET /api/devices": reply(200, NO_DEVICES) });
    await page.goto("/");
    await page.getByRole("button", { name: "Skip the rest" }).click();
    await expect(page.getByRole("heading", { level: 2, name: SESSION.cafe.name })).toBeFocused();
    expect(server.milestones).toEqual(["setupFinishedAt"]);
    const checklist = page.getByRole("region", { name: "Finish setting up" });
    await expect(checklist).toContainText("0 of 5 done.");
    const links = checklist.getByRole("link");
    await expect(links).toHaveText(["Set the program", "Add an order type", "Add a barista", "Pair a phone", "Print the QR"]);
    expect(await links.evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href")))).toEqual(["/cafe#program", "/cafe#menu", "/staff", "/devices", "/cafe/print-qr"]);
  });

  test.describe("in Arabic", () => {
    test.use({ locale: "ar-LB" });

    test("says each step and its count in Arabic", async ({ page }) => {
      const server = setupServer({ program: null, setupFinishedAt: null });
      await mockApi(page, { ...server.routes, "GET /api/staff": reply(200, { staff: [] }), "GET /api/devices": reply(200, NO_DEVICES) });
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 2, name: "جهّز مقهاك" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 3, name: "الخطوة \u20681\u2069 من \u20685\u2069 برنامج الولاء" })).toBeVisible();
      await page.getByRole("button", { name: "تخطَّ هذه الخطوة" }).click();
      await expect(page.getByRole("heading", { level: 3, name: "الخطوة \u20682\u2069 من \u20685\u2069 نوع الطلب الأول" })).toBeFocused();
    });
  });
});

test.describe("setup checklist (D22)", () => {
  test("is gone once every step is done", async ({ page }) => {
    const done = "2026-10-19T09:00:00.000Z";
    // The phones are answered only after the staff: Needs you's "Nothing needs you" (which waits for the phones) then
    // shows only once the checklist has both lists.
    let staffServed: () => void = () => undefined;
    const staff = new Promise<void>((resolve) => {
      staffServed = resolve;
    });
    await mockApi(page, {
      ...setupServer({ program: PROGRAM, setupFinishedAt: done }).routes,
      "GET /api/cafe": reply(200, { cafe: { ...CAFE, setupFinishedAt: done, signupQrPrintedAt: done }, program: PROGRAM, orderTypes: [ESPRESSO] }),
      "GET /api/staff": async (route) => {
        await route.fulfill({ json: { staff: [RAMI] } });
        staffServed();
      },
      "GET /api/devices": async (route) => {
        await staff;
        await route.fulfill({
          json: { devices: [{ id: "7d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f43", name: "Front counter", pairedAt: done, lastSeenAt: new Date().toISOString(), revoked: false }], pairingCodes: [], counterUrl: "https://counter.example.test" },
        });
      },
    });
    await page.goto("/");
    await expect(page.getByText("Nothing needs you right now.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Finish setting up" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Set up your café" })).toHaveCount(0);
  });
});

test.describe("printable signup QR (D6)", () => {
  for (const [locale, print, sheets] of [
    ["en-US", "Print", { ar: ["Arabic sheet", "Print the Arabic sheet"], en: ["English sheet", "Print the English sheet"] }],
    ["ar-LB", "طباعة", { ar: ["الورقة العربية", "طباعة الورقة العربية"], en: ["الورقة الإنكليزية", "طباعة الورقة الإنكليزية"] }],
  ] as const) {
    test.describe(locale, () => {
      test.use({ locale });

      test("opens from the Café page and prints the Arabic or the English sheet alone, recording the first print", async ({ page }) => {
        const server = setupServer({ program: PROGRAM, setupFinishedAt: "2026-10-19T09:00:00.000Z" });
        await page.addInitScript(fakePrint);
        await mockApi(page, server.routes);
        await page.goto("/cafe");
        await page.getByRole("link", { name: print, exact: true }).click();
        await expect(page).toHaveURL(/\/cafe\/print-qr$/);
        // Both sheets whatever the dashboard's language, each in its own language only.
        const arabic = page.getByRole("region", { name: sheets.ar[0] }).locator(".print-sheet");
        const english = page.getByRole("region", { name: sheets.en[0] }).locator(".print-sheet");
        await expect(arabic).toHaveAttribute("lang", "ar");
        await expect(arabic).toHaveAttribute("dir", "rtl");
        await expect(arabic).toContainText("احصل على بطاقة الولاء");
        await expect(arabic).not.toContainText("Get your loyalty card");
        await expect(english).toHaveAttribute("lang", "en");
        await expect(english).toContainText("Get your loyalty card");
        await expect(english).not.toContainText("احصل على بطاقة الولاء");
        for (const sheet of [arabic, english]) {
          await expect(sheet).toContainText(SESSION.cafe.name);
          await expect(sheet.getByRole("img")).toBeVisible();
        }

        // Each sheet's button prints it alone (the fake print leaves the chosen sheet set, as a dialog still open would).
        const printArabic = page.getByRole("button", { name: sheets.ar[1] });
        await printArabic.click();
        await printArabic.click();
        await expect.poll(() => server.milestones).toEqual(["signupQrPrintedAt"]);
        await page.emulateMedia({ media: "print" });
        for (const chrome of [page.getByRole("navigation", { name: locale === "ar-LB" ? "لوحة التحكم" : "Dashboard" }), page.getByRole("banner"), printArabic]) {
          await expect(chrome).toBeHidden();
        }
        await expect(arabic).toBeVisible();
        await expect(english).toBeHidden();
        // The code about 8 cm across on paper (96 CSS px to the inch).
        const width = await arabic.getByRole("img").evaluate((image) => image.getBoundingClientRect().width);
        expect(Math.abs(width - (8 / 2.54) * 96)).toBeLessThanOrEqual(2);
        await page.emulateMedia({ media: "screen" });
        await page.getByRole("button", { name: sheets.en[1] }).click();
        await page.emulateMedia({ media: "print" });
        await expect(english).toBeVisible();
        await expect(arabic).toBeHidden();

        // The browser's own Print command (after the dialog closes): both sheets, the English one on a page of its own.
        await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
        await expect(arabic).toBeVisible();
        await expect(english).toBeVisible();
        expect(await page.getByRole("region", { name: sheets.en[0] }).evaluate((column) => getComputedStyle(column).breakBefore)).toBe("page");
      });
    });
  }
});

test.describe("Staff and Devices (D5, D14)", () => {
  const code = (expiresAt: string) => ({
    id: "8d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f45",
    deviceName: "Back bar",
    code: "ABCD-EFGH-JKMN",
    pairingUrl: "https://counter.example.test/pair#code=ABCDEFGHJKMN",
    expiresAt,
  });

  test("shows a PIN on request and hides it again, focus staying on the toggle", async ({ page }) => {
    await mockApi(page, { "GET /api/auth/session": reply(200, SESSION), "GET /api/staff": reply(200, { staff: [] }) });
    await page.goto("/staff");
    const pin = page.getByLabel("PIN");
    await pin.fill("482913");
    const toggle = page.getByRole("button", { name: "Show" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(pin).toHaveAttribute("type", "text");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toBeFocused();
    await toggle.press("Enter");
    await expect(pin).toHaveAttribute("type", "password");
  });

  test("counts a pairing code down, then offers a new one once it expires", async ({ page }) => {
    // The page's clock, not the test runner's: codes expire on the page's time.
    const now = new Date("2026-10-08T12:30:00.000Z");
    await page.clock.install({ time: now });
    const created: unknown[] = [];
    await mockApi(page, {
      "GET /api/auth/session": reply(200, SESSION),
      "GET /api/devices": reply(200, { devices: [], pairingCodes: [], counterUrl: "https://counter.example.test" }),
      "POST /api/devices/pairing-codes": async (route) => {
        created.push(json(route));
        // The second is a new code, as the server makes one: its own id, ten minutes from when it is asked for.
        const made =
          created.length === 1
            ? code(new Date(now.getTime() + 90_000).toISOString())
            : { ...code(new Date(now.getTime() + 91_000 + 600_000).toISOString()), id: "8d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f46" };
        await route.fulfill({ status: 201, json: made });
      },
    });
    await page.goto("/devices");
    await page.getByLabel("Phone name").fill("Back bar");
    await page.getByRole("button", { name: "Create pairing code" }).click();
    await expect(page.getByText(/^Expires in 1:(30|29)\.$/)).toBeVisible();
    await page.clock.fastForward(30_000);
    await expect(page.getByText(/^Expires in 1:0\d\.$/)).toBeVisible();
    await page.clock.fastForward(61_000);
    await expect(page.getByText("This code has expired. Create a new one to pair Back bar.")).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("The pairing code for Back bar has expired.");
    await expect(page.getByText("ABCD-EFGH-JKMN")).toHaveCount(0);
    await page.getByRole("button", { name: "New code" }).click();
    await expect(page.getByRole("heading", { name: "Pair Back bar" })).toBeFocused();
    await expect(page.getByText(/^Expires in (10:00|9:59)\.$/)).toBeVisible();
    expect(created).toEqual([{ deviceName: "Back bar" }, { deviceName: "Back bar" }]);
  });

  test("keeps removed phones in a closed Removed group", async ({ page }) => {
    await mockApi(page, {
      "GET /api/auth/session": reply(200, SESSION),
      "GET /api/devices": reply(200, {
        devices: [
          { id: "7d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f46", name: "Front counter", pairedAt: "2026-10-08T12:00:00.000Z", lastSeenAt: "2026-10-08T12:30:00.000Z", revoked: false },
          { id: "7d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f47", name: "Old phone", pairedAt: "2026-09-08T12:00:00.000Z", lastSeenAt: "2026-09-20T12:30:00.000Z", revoked: true },
        ],
        pairingCodes: [], counterUrl: "https://counter.example.test",
      }),
    });
    await page.goto("/devices");
    await expect(page.getByText("Front counter", { exact: true })).toBeVisible();
    await expect(page.getByText("Old phone")).toBeHidden();
    await page.getByText("Removed (1)").click();
    await expect(page.getByText("Old phone · removed")).toBeVisible();
  });
});
