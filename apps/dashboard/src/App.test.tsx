import { PRODUCT_NAME } from "@cafe-loyalty/shared";
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

/** The home page's own requests, answered as for a café on its pilot plan with nothing to report. */
const CAFE_SETUP = {
  cafe: { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1, minMarginPercent: 0, winBack: { discount: null, cooldownDays: 30 }, googleReviewUrl: null, plan: "pilot" },
  program: null,
  orderTypes: [],
};
const homeData = (path: string): Response | undefined =>
  path === "/api/cafe/wallet-deliveries"
    ? respond(200, { failing: [] })
    : path === "/api/cafe/visit-hours"
      ? respond(200, visitHours())
      : path === "/api/cafe"
        ? respond(200, CAFE_SETUP)
        : undefined;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Dashboard App", () => {
  it("shows the heading, the build id and the sign-in form when signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(unauthenticated())));
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: `${PRODUCT_NAME} Dashboard` })).toBeInTheDocument();
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
    // ISO weekdays from Monday, as the server indexes them: data column 5 is Saturday.
    expect(within(rows[0] ?? table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Hour",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
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
    // And every hour after that, not just once.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await waitFor(() => {
      expect(loads()).toBe(3);
    });
  });

  it("keeps the hours shown when a reload fails, says so without an alert, and tries again 5 minutes later", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let loads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        if (path !== "/api/cafe/visit-hours") {
          return Promise.resolve(path === "/api/auth/session" ? respond(200, SESSION) : (homeData(path) ?? unauthenticated()));
        }
        loads += 1;
        return loads === 2 ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(respond(200, visitHours([[5, 9, loads === 1 ? 8 : 9]])));
      }),
    );
    render(<App />);
    const section = await screen.findByRole("region", { name: "Busy and quiet hours" });
    expect(await within(section).findByRole("cell", { name: "8" })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(await within(section).findByText(/Could not update these hours: Could not reach the server/)).toHaveTextContent("tries again in 5 minutes");
    expect(within(section).getByRole("cell", { name: "8" })).toBeInTheDocument();
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(section).toHaveTextContent("(Asia/Beirut)");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(await within(section).findByRole("cell", { name: "9" })).toBeInTheDocument();
    expect(within(section).queryByText(/Could not update these hours/)).toBeNull();
    // Back to hourly once a load succeeds again.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(loads).toBe(3);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await waitFor(() => {
      expect(loads).toBe(4);
    });
  });

  it("says when the hours cannot be loaded at all, and when it tries again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        path === "/api/cafe/visit-hours"
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(path === "/api/auth/session" ? respond(200, SESSION) : (homeData(path) ?? unauthenticated())),
      ),
    );
    render(<App />);
    const section = await screen.findByRole("region", { name: "Busy and quiet hours" });
    expect(await within(section).findByRole("alert")).toHaveTextContent("Could not load the busy and quiet hours: Could not reach the server.");
    expect(within(section).getByRole("alert")).toHaveTextContent("This page tries again in 5 minutes.");
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
