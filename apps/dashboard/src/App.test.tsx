import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const SESSION = {
  owner: { id: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40", email: "rana@example.com" },
  cafe: { id: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", name: "Café Najjar" },
};

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const unauthenticated = () => respond(401, { code: "UNAUTHENTICATED", message: "Your session has ended. Sign in again.", retryable: false });

/** Member visits of four weeks; `busy` sets [weekday index, hour, visits] cells. */
const visitHours = (busy: [number, number, number][] = []) => ({
  timeZone: "Asia/Beirut",
  from: "2026-09-11T08:00:00.000Z",
  to: "2026-10-09T08:00:00.000Z",
  visits: Array.from({ length: 7 }, (_, weekday) =>
    Array.from({ length: 24 }, (_, hour) => busy.find(([day, at]) => day === weekday && at === hour)?.[2] ?? 0),
  ),
});

/** The home page's own requests, answered as for a café with nothing to report. */
const homeData = (path: string): Response | undefined =>
  path === "/api/cafe/wallet-deliveries" ? respond(200, { failing: [] }) : path === "/api/cafe/visit-hours" ? respond(200, visitHours()) : undefined;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Dashboard App", () => {
  it("shows the heading, the build id and the sign-in form when signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(unauthenticated())));
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Cafe Loyalty Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Build test-build")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("signs in and shows the café", async () => {
    const fetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>((path) =>
      Promise.resolve(
        path === "/api/auth/login" ? respond(200, SESSION) : (homeData(path) ?? unauthenticated()),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "rana@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Café Najjar" })).toBeInTheDocument();
    expect(screen.getByText("Signed in as rana@example.com")).toBeInTheDocument();
    const [, init] = fetch.mock.calls.find(([path]) => path === "/api/auth/login") ?? [];
    expect(JSON.parse(init?.body as string)).toEqual({ email: "rana@example.com", password: "correct horse battery" });
  });

  it("warns when customers' wallet cards keep failing to update (AC 13)", async () => {
    const failing = [{ wallet: "apple", passes: 1, lastFailedAt: "2026-10-09T08:00:00.000Z", lastError: "apns_503_ServiceUnavailable" }];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        Promise.resolve(
          path === "/api/auth/session"
            ? respond(200, SESSION)
            : path === "/api/cafe/wallet-deliveries"
              ? respond(200, { failing })
              : (homeData(path) ?? unauthenticated()),
        ),
      ),
    );
    render(<App />);
    const warning = await screen.findByRole("region", { name: "Wallet card updates are failing" });
    expect(warning).toHaveTextContent("Some customers' wallet cards are not showing their latest stamps");
    expect(warning).toHaveTextContent("Apple Wallet: 1 card, last failure");
    expect(warning).toHaveTextContent("apns_503_ServiceUnavailable");
  });

  it("shows members' visits by hour and weekday from the first to the last busy hour, and loads them again every hour (AC 34)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/auth/session"
          ? respond(200, SESSION)
          : path === "/api/cafe/visit-hours"
            ? respond(200, visitHours([[5, 9, 8], [0, 11, 2]]))
            : (homeData(path) ?? unauthenticated()),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    const table = await screen.findByRole("table", { name: "Member visits by hour and weekday" });
    const section = screen.getByRole("region", { name: "Busy and quiet hours" });
    expect(section).toContainElement(table);
    expect(section).toHaveTextContent("Members only: visits recorded with a loyalty card over the last 4 weeks");
    expect(section).toHaveTextContent("(Asia/Beirut)");
    const rows = within(table).getAllByRole("row");
    expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual(["Hour", "09:00", "10:00", "11:00"]);
    const saturdayNine = within(rows[1] ?? table).getAllByRole("cell")[5];
    expect(saturdayNine).toHaveTextContent("8");
    expect(saturdayNine).toHaveClass("level-4");
    expect(within(rows[3] ?? table).getAllByRole("cell")[0]).toHaveClass("level-1");
    const loads = () => fetch.mock.calls.filter(([path]) => path === "/api/cafe/visit-hours").length;
    expect(loads()).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await waitFor(() => {
      expect(loads()).toBe(2);
    });
  });

  it("says so when there are no member visits yet", async () => {
    vi.stubGlobal("fetch", vi.fn((path: string) => Promise.resolve(path === "/api/auth/session" ? respond(200, SESSION) : (homeData(path) ?? unauthenticated()))));
    render(<App />);
    expect(await screen.findByText("No member visits in the last 4 weeks yet.")).toBeInTheDocument();
  });

  it("shows the server's message when sign-in fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        Promise.resolve(
          path === "/api/auth/login"
            ? respond(401, { code: "UNAUTHENTICATED", message: "The email or password is wrong. Try again, or reset your password.", retryable: false })
            : unauthenticated(),
        ),
      ),
    );
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "rana@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The email or password is wrong.");
  });

  it("offers to try again when the server cannot be reached", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(respond(200, SESSION));
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Café Najjar" })).toBeInTheDocument();
  });
});
