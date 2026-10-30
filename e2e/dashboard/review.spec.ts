import { expect, test } from "@playwright/test";
import { shownText } from "../a11y.js";
import { SESSION, mockApi, reply } from "./api-mock.js";

// Times in button names are shown in the browser's zone; pin it so the names are the same on every machine.
test.use({ timezoneId: "UTC" });

const held = (index: number) => ({
  id: `5e1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f${String(index).padStart(2, "0")}`,
  type: "visit.recorded",
  deviceName: "Front counter",
  staffName: "Rami",
  reason: "device_revoked",
  discountRefused: false,
  visit: { stamps: 1, totalCents: 600, items: [{ nameEn: "Latte", nameAr: "لاتيه", quantity: 1 }, { nameEn: "Croissant", nameAr: "كرواسان", quantity: 1 }] },
  occurredAt: `2026-10-08T0${String(index % 10)}:15:00.000Z`,
  receivedAt: "2026-10-08T12:00:00.000Z",
});

test("lists held events a page at a time and accepts one in a tap, sent after 10 seconds (AC 21, D8)", async ({ page }) => {
  await page.clock.install();
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/review-queue": async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      if (cursor === "page-2") {
        await route.fulfill({ json: { items: [held(3)], nextCursor: null } });
      } else {
        await route.fulfill({ json: { items: [held(1), held(2)], nextCursor: "page-2" } });
      }
    },
    [`POST /api/review-queue/${held(1).id}/accept`]: reply(200, { outcome: "OK" }),
    [`POST /api/review-queue/${held(2).id}/accept`]: reply(200, { outcome: "STAMP_COOLDOWN" }),
  });
  await page.goto("/review");
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  await expect(page.getByText(/^Visit at .* from a phone you removed: Rami on Front counter/)).toHaveCount(2);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.getByText(/from a phone you removed/)).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(0);
  // The last page took focus at its first item, as the button it replaced went away.
  await expect(page.getByRole("listitem").filter({ hasText: "03:15" })).toBeFocused();

  const first = page.getByRole("button", { name: /^Accept Visit by Rami on Front counter at 8 Oct 2026, 01:15:00$/ });
  // Short visible labels; the names keep the item's description (AC 9).
  expect(await shownText(first)).toBe("Accept");
  expect(await shownText(page.getByRole("button", { name: /^Discard Visit by Rami on Front counter at 8 Oct 2026, 01:15:00$/ }))).toBe("Discard");
  await first.click();
  // Undo and its 10 seconds come first in its name, and the status does not repeat the item (D8).
  const undo = page.getByRole("button", { name: /^Undo within 10 seconds: accepting Visit by Rami on Front counter at 8 Oct 2026, 01:15:00$/ });
  await expect(undo).toBeFocused();
  expect(await shownText(undo)).toBe("Undo");
  await expect(page.getByRole("status")).toHaveText("");
  await page.clock.fastForward(10_000);
  await expect(page.getByRole("status")).toHaveText("Accepted: Visit by Rami on Front counter at 8 Oct 2026, 01:15:00.");
  // Only the decided item goes: the pages already loaded stay.
  await expect(page.getByText(/from a phone you removed/)).toHaveCount(2);

  // An accepted visit that added no stamps says why.
  await page.getByRole("button", { name: /^Accept Visit by Rami on Front counter at 8 Oct 2026, 02:15:00$/ }).click();
  await page.clock.fastForward(10_000);
  await expect(page.getByRole("status")).toHaveText(
    "Accepted: Visit by Rami on Front counter at 8 Oct 2026, 02:15:00. It counts as a visit, but the card got no stamps: the card got stamps less than 30 minutes before it.",
  );
});

test("shows what a held visit holds, and Undo takes an accept back without sending it (D8)", async ({ page }) => {
  await page.clock.install();
  const sent: string[] = [];
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/review-queue": reply(200, { items: [held(1)], nextCursor: null }),
    [`POST /api/review-queue/${held(1).id}/accept`]: async (route) => {
      sent.push(route.request().url());
      await route.fulfill({ json: { outcome: "OK" } });
    },
  });
  await page.goto("/review");
  const item = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: /^Accept Visit by Rami/ }) });
  await expect(item).toContainText("Order: 1 × Latte, 1 × Croissant. Total $6.00, for 1 stamp.");
  await page.getByRole("button", { name: /^Accept Visit by Rami/ }).click();
  await expect(page.getByText("Accepted in 10 seconds unless you undo it.")).toBeVisible();
  await page.clock.fastForward(9_000);
  await page.getByRole("button", { name: /^Undo within 10 seconds: accepting Visit by Rami/ }).click();
  await expect(page.getByRole("button", { name: /^Accept Visit by Rami/ })).toBeFocused();
  await expect(page.getByRole("status")).toHaveText(/^Not accepted: Visit by Rami/);
  await page.clock.fastForward(20_000);
  expect(sent).toEqual([]);
  // Discard still asks first.
  await page.getByRole("button", { name: /^Discard Visit by Rami/ }).click();
  await expect(page.getByRole("button", { name: /^Yes, discard Visit by Rami/ })).toBeVisible();
});

test("sends an accept still waiting when the owner leaves the page", async ({ page }) => {
  await page.clock.install();
  let accepted = false;
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/review-queue": reply(200, { items: [held(1)], nextCursor: null }),
    [`POST /api/review-queue/${held(1).id}/accept`]: async (route) => {
      accepted = true;
      await route.fulfill({ json: { outcome: "OK" } });
    },
  });
  await page.goto("/review");
  await page.getByRole("button", { name: /^Accept Visit by Rami/ }).click();
  // The page going away: a request made while it really unloads never reaches Playwright's routes, so the event is
  // sent to the live page; the browser finishes a keepalive request after the page has gone.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect.poll(() => accepted).toBe(true);
});

test("says when there is nothing to review", async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(200, SESSION), "GET /api/review-queue": reply(200, { items: [], nextCursor: null }) });
  await page.goto("/review");
  await expect(page.getByText("Nothing to review.")).toBeVisible();
});

test("says when a late visit's discount also failed its campaign check (AC 35)", async ({ page }) => {
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/review-queue": reply(200, { items: [{ ...held(1), reason: "late_sync", discountRefused: true }, { ...held(2), reason: "campaign_check", discountRefused: true }], nextCursor: null }),
  });
  await page.goto("/review");
  const late = page.getByRole("listitem").filter({ hasText: "01:15" });
  await expect(late).toContainText("that reached the server more than two days later");
  await expect(late).toContainText("It also has a discount its campaign or the card's welcome-back offer did not allow");
  // A campaign hold says so once, in its reason.
  const held2 = page.getByRole("listitem").filter({ hasText: "02:15" });
  await expect(held2).toContainText("with a discount its campaign or the card's welcome-back offer did not allow at that time");
  await expect(held2).not.toContainText("It also has");
});

test("still lists a held event whose reason a newer server added, after a rollback or before a reload", async ({ page }) => {
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/review-queue": reply(200, { items: [{ ...held(1), reason: "a_reason_from_later" }, held(2)], nextCursor: null }),
  });
  await page.goto("/review");
  await expect(page.getByRole("listitem").filter({ hasText: "01:15" })).toContainText("for a reason this page does not know yet (reload it): Rami on Front counter");
  await expect(page.getByRole("listitem").filter({ hasText: "02:15" })).toContainText("from a phone you removed");
});
