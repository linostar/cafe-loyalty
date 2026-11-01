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

const SECOND = { ...ITEM, id: "5e1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f02", staffName: "Lina" };
const THIRD = { ...ITEM, id: "5e1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f03", staffName: "Omar" };

const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * Serves the queue (`items`, with a next page of THIRD when `more`); a request whose path ends with `slow` waits
 * until the returned `release` is called. Returns the accepts and discards sent, and `release`.
 */
function serve({ items = [ITEM], more = false, slow }: { items?: unknown[]; more?: boolean; slow?: string } = {}) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async (path) => {
    if (slow !== undefined && path.endsWith(slow)) {
      await held;
    }
    if (path === "/api/review-queue") {
      return respond({ items, nextCursor: more ? "next" : null });
    }
    return path.startsWith("/api/review-queue?cursor=") ? respond({ items: [THIRD], nextCursor: null }) : respond({ outcome: "OK" });
  });
  vi.stubGlobal("fetch", fetch);
  const sent = () => fetch.mock.calls.filter(([path]) => path.endsWith("/accept") || path.endsWith("/discard"));
  const accepts = () => fetch.mock.calls.filter(([path]) => path.endsWith("/accept"));
  return Object.assign(accepts, {
    sent,
    release: () => {
      release();
    },
  });
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
    // Focus says Undo and the 10 seconds first; the status does not repeat the item (D8).
    const undo = screen.getByRole("button", { name: /^Undo within 10 seconds: accepting Visit by Rami/ });
    expect(undo).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(/^$/);
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

  it("sends two accepts whose requests overlap, one after the other", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const accepts = serve({ items: [ITEM, SECOND], slow: `${ITEM.id}/accept` });
    render(<ReviewPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Accept Visit by Rami/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Accept Visit by Lina/ }));
    // Rami's accept is on its way when Lina's wait ends: hers is sent next, not dropped.
    await act(() => vi.advanceTimersByTimeAsync(ACCEPT_DELAY_MS + 100));
    expect(accepts().map(([path]) => path)).toEqual([`/api/review-queue/${ITEM.id}/accept`]);
    act(accepts.release);
    await waitFor(() => {
      expect(accepts().map(([path]) => path)).toEqual([`/api/review-queue/${ITEM.id}/accept`, `/api/review-queue/${SECOND.id}/accept`]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^Accept Visit by Lina/ })).toBeNull();
    });
  });

  it("sends an accept whose wait ends while a Discard is on its way", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const accepts = serve({ items: [ITEM, SECOND], slow: "/discard" });
    render(<ReviewPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Accept Visit by Rami/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Discard Visit by Lina/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Yes, discard Visit by Lina/ }));
    await act(() => vi.advanceTimersByTimeAsync(ACCEPT_DELAY_MS + 100));
    expect(accepts.sent().map(([path]) => path)).toEqual([`/api/review-queue/${SECOND.id}/discard`]);
    act(accepts.release);
    await waitFor(() => {
      expect(accepts.sent().map(([path]) => path)).toEqual([`/api/review-queue/${SECOND.id}/discard`, `/api/review-queue/${ITEM.id}/accept`]);
    });
  });

  it("sends an accept whose wait ends while Show more is loading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const accepts = serve({ more: true, slow: "?cursor=next" });
    render(<ReviewPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Accept Visit by Rami/ }));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await act(() => vi.advanceTimersByTimeAsync(ACCEPT_DELAY_MS + 100));
    expect(accepts()).toEqual([]);
    act(accepts.release);
    expect(await screen.findByRole("button", { name: /^Accept Visit by Omar/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(accepts().map(([path]) => path)).toEqual([`/api/review-queue/${ITEM.id}/accept`]);
    });
  });

  it("sends an accept queued behind another request when the page is left, and never twice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const accepts = serve({ items: [ITEM, SECOND], slow: `${ITEM.id}/accept` });
    render(<ReviewPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Accept Visit by Rami/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Accept Visit by Lina/ }));
    await act(() => vi.advanceTimersByTimeAsync(ACCEPT_DELAY_MS + 100));
    // Rami's is on its way, sent with keepalive so the browser finishes it; Lina's waits behind it.
    expect(accepts()).toEqual([[`/api/review-queue/${ITEM.id}/accept`, expect.objectContaining({ keepalive: true })]]);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(accepts().map(([path]) => path)).toEqual([`/api/review-queue/${ITEM.id}/accept`, `/api/review-queue/${SECOND.id}/accept`]);
    // When Rami's answer comes, Lina's queued request finds hers sent and sends nothing more.
    act(accepts.release);
    await act(() => vi.advanceTimersByTimeAsync(ACCEPT_DELAY_MS));
    expect(accepts()).toHaveLength(2);
  });

  it("loads the queue again when the page comes back from the back-forward cache", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const accepts = serve({ items: [ITEM, SECOND] });
    const fetch = vi.mocked(globalThis.fetch);
    render(<ReviewPage />);
    fireEvent.click(await screen.findByRole("button", { name: /^Accept Visit by Rami/ }));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(accepts()).toHaveLength(1);
    // Rami's visit was accepted as the page left: the queue served on return no longer has it.
    fetch.mockImplementation((path) => Promise.resolve(path === "/api/review-queue" ? respond({ items: [SECOND], nextCursor: null }) : respond({ outcome: "OK" })));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^Accept Visit by Rami/ })).toBeNull();
    });
    expect(screen.getByRole("button", { name: /^Accept Visit by Lina/ })).toBeInTheDocument();
  });
});
