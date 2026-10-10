import { expect, test } from "@playwright/test";
import { SESSION, mockApi, reply } from "./api-mock.js";

// Times in button names are shown in the browser's zone; pin it so the names are the same on every machine.
test.use({ timezoneId: "UTC" });

// Fake messages for the test only.
const message = (index: number, read: boolean) => ({
  id: `7a1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f${String(index).padStart(2, "0")}`,
  message: index === 1 ? "The croissant was cold.\nThe latte was great." : "Lovely music this morning.",
  receivedAt: `2026-10-08T1${String(index)}:30:00.000Z`,
  visitedAt: `2026-10-08T0${String(index + 7)}:00:00.000Z`,
  read,
});

test("shows customers' private feedback, newest first, and marks a message read (AC 37)", async ({ page }) => {
  const read: string[] = [];
  await mockApi(page, {
    "GET /api/auth/session": reply(200, SESSION),
    "GET /api/feedback": reply(200, { items: [message(1, false), message(2, true)], unread: 1, more: false }),
    [`POST /api/feedback/${message(1, false).id}/read`]: async (route) => {
      read.push(message(1, false).id);
      await route.fulfill({ json: { read: true } });
    },
  });
  await page.goto("/");
  await page.getByRole("navigation").getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("1 unread message.")).toBeVisible();
  const first = page.getByRole("listitem").filter({ hasText: "The croissant was cold." });
  // As written, line break kept.
  await expect(first.getByText("The croissant was cold.\nThe latte was great.")).toBeVisible();
  await expect(first.getByText("Received 8 Oct 2026, 11:30, about a visit in the hour from 8 Oct 2026, 08:00")).toBeVisible();
  await expect(first.getByText("New", { exact: true })).toBeVisible();
  // A read message has no button.
  await expect(page.getByRole("button", { name: /^Mark the message of/ })).toHaveCount(1);
  await page.getByRole("button", { name: "Mark the message of 8 Oct 2026, 11:30 as read" }).click();
  await expect(page.getByText("No unread messages.")).toBeVisible();
  await expect(first.getByText("New", { exact: true })).toHaveCount(0);
  expect(read).toEqual([message(1, false).id]);
});

test("says when there are no messages yet", async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(200, SESSION), "GET /api/feedback": reply(200, { items: [], unread: 0, more: false }) });
  await page.goto("/inbox");
  await expect(page.getByText("No messages yet.")).toBeVisible();
});
