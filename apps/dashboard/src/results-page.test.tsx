import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResultsPage } from "./results-page.js";

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const MONTHS = ["2026-10", "2026-09"];
// Fake figures for the test only.
const report = (month: string, memberVisits: number) => ({
  month,
  current: month === MONTHS[0],
  months: MONTHS,
  memberVisits,
  customersWonBack: 2,
  quietHourVisits: 7,
  rewardRedemptions: 3,
  offers: { winBack: { visits: 2, costCents: 60, revenueCents: 540 }, quietHour: { visits: 7, costCents: 350, revenueCents: 2100 } },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Results page", () => {
  it("shows the current month so far, and another month picked from the list, keeping focus on the picker", async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetch = vi.fn((path: string) =>
      path === "/api/results"
        ? Promise.resolve(respond(200, report("2026-10", 40)))
        : new Promise<Response>((resolve) => {
            answer = resolve;
          }),
    );
    vi.stubGlobal("fetch", fetch);
    render(<ResultsPage />);
    expect(await screen.findByRole("heading", { name: "Results" })).toBeInTheDocument();
    const picker = screen.getByRole("combobox", { name: "Month" });
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual(["October 2026 (so far)", "September 2026"]);
    expect(picker).toHaveValue("2026-10");
    expect(screen.getByText(/^October 2026 so far, still running\./)).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    picker.focus();
    fireEvent.change(picker, { target: { value: "2026-09" } });
    expect(fetch).toHaveBeenLastCalledWith("/api/results?month=2026-09", expect.anything());
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    // The other month's figures are not shown as this one's.
    expect(screen.queryByText("40")).not.toBeInTheDocument();
    answer(respond(200, report("2026-09", 31)));
    expect(await screen.findByText("Showing September 2026.")).toBeInTheDocument();
    expect(screen.getByText(/^All of September 2026\./)).toBeInTheDocument();
    expect(screen.getByText("31")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Offers in September 2026" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: "Welcome-back offers 2 $0.60 $5.40" })).toBeInTheDocument();
    expect(picker).toHaveFocus();
  });

  it("keeps the picker when a month fails to load, and loads it again", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        Promise.resolve(
          path === "/api/results"
            ? respond(200, report("2026-10", 40))
            : fail
              ? respond(500, { code: "INTERNAL", message: "Something went wrong on our side. Try again in a moment.", retryable: true })
              : respond(200, report("2026-09", 31)),
        ),
      ),
    );
    render(<ResultsPage />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Month" }), { target: { value: "2026-09" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong on our side. Try again in a moment.");
    expect(screen.getByRole("combobox", { name: "Month" })).toHaveValue("2026-09");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("31")).toBeInTheDocument();
  });
});
