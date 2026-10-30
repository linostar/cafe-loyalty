import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevicesPage } from "./devices-page.js";

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const phone = (name: string, revoked: boolean) => ({
  id: crypto.randomUUID(),
  name,
  pairedAt: "2026-10-08T12:00:00.000Z",
  lastSeenAt: "2026-10-08T12:30:00.000Z",
  revoked,
});

const code = (expiresInMs: number) => ({
  id: crypto.randomUUID(),
  deviceName: "Back bar",
  code: "ABCD-EFGH-JKMN",
  pairingUrl: "https://counter.example.test/pair#code=ABCDEFGHJKMN",
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Devices", () => {
  it("counts a new code down, says once that it expired and offers a new one (D14)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const codes = [code(65_000)];
    const fetch = vi.fn((path: string, init?: RequestInit) =>
      Promise.resolve(
        path === "/api/devices" ? respond({ devices: [], pairingCodes: [] }) : init?.method === "POST" ? respond(codes.shift() ?? code(600_000), 201) : respond({}),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(<DevicesPage />);
    fireEvent.change(await screen.findByLabelText("Phone name"), { target: { value: "Back bar" } });
    fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    expect(await screen.findByText("Expires in 1:05.")).toBeInTheDocument();
    // Not a live region: it would speak every second.
    expect(screen.getByText("Expires in 1:05.").closest("[role=status], [aria-live]")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText("Expires in 1:04.")).toBeInTheDocument();
    // A second at a time: each tick schedules the next once rendered.
    for (let second = 0; second < 64; second += 1) {
      await act(() => vi.advanceTimersByTimeAsync(1000));
    }
    expect(screen.getByText("This code has expired. Create a new one to pair Back bar.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("The pairing code for Back bar has expired.");
    expect(screen.queryByText("ABCD-EFGH-JKMN")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New code" }));
    expect(await screen.findByText("Expires in 10:00.")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Pair Back bar" })).toHaveFocus();
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ deviceName: "Back bar" }),
      JSON.stringify({ deviceName: "Back bar" }),
    ]);
  });

  it("keeps removed phones in a closed Removed group", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(respond({ devices: [phone("Front counter", false), phone("Old phone", true)], pairingCodes: [] }))));
    render(<DevicesPage />);
    const group = (await screen.findByText("Removed (1)")).closest("details");
    expect(group).not.toHaveAttribute("open");
    expect(group).toHaveTextContent("Old phone");
    expect(group).not.toHaveTextContent("Front counter");
  });

  it("says no phone can record visits when every one is removed", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(respond({ devices: [phone("Old phone", true)], pairingCodes: [] }))));
    render(<DevicesPage />);
    expect(await screen.findByText("Every phone is removed: none can record visits. Pair one above to start again.")).toBeInTheDocument();
    expect(screen.getByText("Removed (1)")).toBeInTheDocument();
  });

  it("does not bring a dismissed code back when its renewal is answered after Done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer: (response: Response) => void = () => undefined;
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        if (path === "/api/devices") {
          return Promise.resolve(respond({ devices: [], pairingCodes: [] }));
        }
        posts += 1;
        // The first code expires at once; its renewal waits until the test answers it.
        return posts === 1 ? Promise.resolve(respond(code(1_000), 201)) : new Promise<Response>((resolve) => (answer = resolve));
      }),
    );
    render(<DevicesPage />);
    fireEvent.change(await screen.findByLabelText("Phone name"), { target: { value: "Back bar" } });
    fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    await screen.findByText("Expires in 0:01.");
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    fireEvent.click(screen.getByRole("button", { name: "New code" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await act(async () => {
      answer(respond(code(600_000), 201));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.queryByRole("heading", { name: "Pair Back bar" })).toBeNull();
  });
});
