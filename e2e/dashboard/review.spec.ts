import { expect, test } from "@playwright/test";
import { SESSION, mockApi, reply } from "./api-mock.js";

const held = (index: number) => ({
  id: `5e1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f${String(index).padStart(2, "0")}`,
  type: "visit.recorded",
  deviceName: "Front counter",
  staffName: "Rami",
  reason: "device_revoked",
  occurredAt: `2026-10-08T0${String(index % 10)}:15:00.000Z`,
  receivedAt: "2026-10-08T12:00:00.000Z",
});

test("lists held events a page at a time and accepts one after confirming (AC 21)", async ({ page }) => {
  let decided = false;
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/review-queue": async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      if (cursor === "page-2") {
        await route.fulfill({ json: { items: [held(3)], nextCursor: null } });
      } else {
        await route.fulfill({ json: { items: decided ? [held(2)] : [held(1), held(2)], nextCursor: decided ? null : "page-2" } });
      }
    },
    [`POST /api/review-queue/${held(1).id}/accept`]: async (route) => {
      decided = true;
      await route.fulfill({ status: 204 });
    },
  });
  await page.goto("/review");
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  await expect(page.getByText(/^Visit at .* from a phone you removed: Rami on Front counter/)).toHaveCount(2);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.getByText(/from a phone you removed/)).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(0);

  await page.getByRole("button", { name: /^Accept visit of / }).first().click();
  await page.getByRole("button", { name: "Yes, accept it" }).click();
  await expect(page.getByRole("status")).toHaveText("Accepted.");
  await expect(page.getByText(/from a phone you removed/)).toHaveCount(1);
});

test("says when there is nothing to review", async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(200, SESSION), "GET /api/review-queue": reply(200, { items: [], nextCursor: null }) });
  await page.goto("/review");
  await expect(page.getByText("Nothing to review.")).toBeVisible();
});
