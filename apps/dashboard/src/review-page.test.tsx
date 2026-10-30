import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCEPT_DELAY_MS, ReviewPage } from "./review-page.js";

const ITEM = {
  id: "5e1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f01",
  type: "visit.recorded",
  deviceName: "Front counter",
  staffName: "Rami",
  reason: "device_revoked",
  discountRefused: false,
  visit: { stamps: 1, totalCents: 1050, items: [{ nameEn: "Espresso", nameAr: "إسبريسو", quantity: 2 }, { nameEn: "Latte", nameAr: "لاتيه", quantity: 1 }] },
  occurredAt: "2026-10-08T01:15:00.000Z",
  receivedAt: "2026-10-08T12:00:00.000Z",
};

const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function serve() {
  const fetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>((path) =>
    Promise.resolve(path === "/api/review-queue" ? respond({ items: [ITEM], nextCursor: null }) : respond({ outcome: "OK" })),
  );
  vi.stubGlobal("fetch", fetch);
  return () => fetch.mock.calls.filter(([path]) => path.endsWith("/accept"));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Review", () => {
  it("shows a held visit's order, total and stamps (D8)", async () => {
    serve();
    render(<ReviewPage />);
    expect(await screen.findByText("Order: 2 × Espresso, 1 × Latte. Total $10.50, for 1 stamp.")).toBeInTheDocument();
  });

  it("accepts in one tap, waits 10 seconds with Undo, and Undo sends nothing (D8)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const accepts = serve();
    render(<ReviewPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Accept Visit by Rami/ }));
    const undo = screen.getByRole("button", { name: /^Undo accepting Visit by Rami/ });
    expect(undo).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(/will be accepted in 10 seconds\. Undo stops it\.$/);
    expect(screen.getByText("Accepted in 10 seconds unless you undo it.")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(ACCEPT_DELAY_MS - 100));
    fireEvent.click(undo);
    expect(screen.getByRole("button", { name: /^Accept Visit by Rami/ })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(/^Not accepted: Visit by Rami/);
    await act(() => vi.advanceTimersByTimeAsync(ACCEPT_DELAY_MS));
    expect(accepts()).toEqual([]);
  });

  it("sends the accept once the 10 seconds are over, then takes the item off the list", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const accepts = serve();
    render(<ReviewPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Accept Visit by Rami/ }));
    await act(() => vi.advanceTimersByTimeAsync(ACCEPT_DELAY_MS - 100));
    expect(accepts()).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(100));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/^Accepted: Visit by Rami/);
    });
    expect(accepts()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Accept Visit by Rami/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Review" })).toHaveFocus();
  });

  it("sends an accept still waiting when the page is left, with keepalive", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const accepts = serve();
    render(<ReviewPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Accept Visit by Rami/ }));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(accepts()).toEqual([[`/api/review-queue/${ITEM.id}/accept`, expect.objectContaining({ method: "POST", keepalive: true, body: "{}" })]]);
    // Sent once: the timer is gone.
    await act(() => vi.advanceTimersByTimeAsync(ACCEPT_DELAY_MS));
    expect(accepts()).toHaveLength(1);
  });

  it("sends an accept still waiting when the owner goes to another page", async () => {
    const accepts = serve();
    const { unmount } = render(<ReviewPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Accept Visit by Rami/ }));
    unmount();
    expect(accepts()).toHaveLength(1);
  });
});
