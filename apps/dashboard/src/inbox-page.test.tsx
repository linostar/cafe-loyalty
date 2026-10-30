import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxPage } from "./inbox-page.js";

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

// Fake messages for the test only.
const message = (index: number, read: boolean) => ({
  id: `7a1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f${String(index).padStart(2, "0")}`,
  message: `Fake message ${String(index)}`,
  receivedAt: `2026-10-0${String(index)}T11:30:00.000Z`,
  visitedAt: `2026-10-0${String(index)}T09:00:00.000Z`,
  read,
});

const itemOf = (text: string) => screen.getByText(text).closest("li");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InboxPage", () => {
  it("moves focus to the next unread message once one is read, an earlier one after the last, then the heading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        Promise.resolve(path.endsWith("/read") ? respond({ read: true }) : respond({ items: [message(3, false), message(2, true), message(1, false)], unread: 2, nextCursor: null })),
      ),
    );
    render(<InboxPage />);
    // Short visible labels, each named after its message.
    const [newest, oldest] = await screen.findAllByRole("button", { name: /^Mark as read: the message of/ });
    expect(newest).toHaveTextContent(/^Mark as read$/);

    fireEvent.click(oldest ?? document.body);
    await waitFor(() => {
      expect(itemOf("Fake message 3")).toHaveFocus();
    });
    expect(screen.getByText("1 unread message.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Mark as read/ }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Inbox" })).toHaveFocus();
    });
    expect(screen.getByText("No unread messages.")).toBeInTheDocument();
  });

  it("loads older messages a page at a time and focuses the first one loaded", async () => {
    const fetch = vi.fn((path: string) =>
      Promise.resolve(
        path.includes("cursor=")
          ? respond({ items: [message(2, false), message(1, true)], unread: 2, nextCursor: null })
          : respond({ items: [message(4, true), message(3, false)], unread: 2, nextCursor: "fake-cursor" }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(<InboxPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Show older messages" }));
    await waitFor(() => {
      expect(itemOf("Fake message 2")).toHaveFocus();
    });
    expect(fetch).toHaveBeenCalledWith("/api/feedback?cursor=fake-cursor", expect.anything());
    expect(screen.getAllByText(/^Fake message/).map((element) => element.textContent)).toEqual(["Fake message 4", "Fake message 3", "Fake message 2", "Fake message 1"]);
    expect(screen.queryByRole("button", { name: "Show older messages" })).not.toBeInTheDocument();
  });

  it("shows a message once when the older page repeats one already shown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        Promise.resolve(
          path.includes("cursor=")
            ? respond({ items: [message(3, false), message(2, false)], unread: 2, nextCursor: null })
            : respond({ items: [message(4, true), message(3, false)], unread: 2, nextCursor: "fake-cursor" }),
        ),
      ),
    );
    render(<InboxPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Show older messages" }));
    await waitFor(() => {
      expect(itemOf("Fake message 2")).toHaveFocus();
    });
    expect(screen.getAllByText(/^Fake message/).map((element) => element.textContent)).toEqual(["Fake message 4", "Fake message 3", "Fake message 2"]);
  });
});
