import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignsPage } from "./campaigns-page.js";

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

// Fake café data for the test only.
const ESPRESSO = { id: "3d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f41", nameAr: "إسبريسو", nameEn: "Espresso", priceCents: 250, costCents: 70, stampsEarned: 1, active: true };
const SETUP = {
  cafe: { id: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", name: "Café Najjar", catalogVersion: 1, minMarginPercent: 30, winBack: { discount: null, cooldownDays: 30 }, googleReviewUrl: null, plan: "pilot" },
  program: null,
  orderTypes: [ESPRESSO],
};
const ENDED = {
  id: "5f3e3c74-9e77-4c2a-9c7a-2f6e3d4c5b63",
  nameAr: "عصر هادئ",
  nameEn: "Quiet afternoons",
  weekdays: [6, 7],
  startsMinute: 900,
  endsMinute: 1440,
  discount: { kind: "amount", value: 50 },
  minMarginPercent: 30,
  // The second order type was removed since.
  orderTypeIds: [ESPRESSO.id, "6a4f4d85-af88-4d3b-8d8b-3a7f4e5d6c74"],
  createdAt: "2026-10-10T08:00:00.000Z",
  endedAt: "2026-10-11T08:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CampaignsPage", () => {
  it("fills the new campaign form from an ended campaign, and picks days with a preset", async () => {
    vi.stubGlobal("fetch", vi.fn((path: string) => Promise.resolve(respond(path === "/api/cafe" ? SETUP : { running: [], ended: [ENDED] }))));
    render(<CampaignsPage />);
    const again = await screen.findByRole("button", { name: "Start again Quiet afternoons" });
    expect(again).toHaveTextContent(/^Start again$/);
    expect(within(screen.getByRole("form", { name: "New campaign" })).getByLabelText("Name (English)")).toHaveValue("");

    fireEvent.click(again);
    // A fresh form, filled in.
    const form = within(screen.getByRole("form", { name: "New campaign" }));
    await waitFor(() => {
      expect(form.getByRole("heading", { name: "New campaign" })).toHaveFocus();
    });
    expect(form.getByLabelText("Name (English)")).toHaveValue("Quiet afternoons");
    expect(form.getByLabelText("Name (Arabic)")).toHaveValue("عصر هادئ");
    expect(form.getByLabelText("Saturday")).toBeChecked();
    expect(form.getByLabelText("Monday")).not.toBeChecked();
    expect(form.getByLabelText("Ends at")).toHaveValue("00:00");
    expect(form.getByLabelText("Amount off each item")).toBeChecked();
    expect(form.getByRole("textbox", { name: "Amount off (USD)" })).toHaveValue("0.50");
    expect(form.getByRole("checkbox", { name: /^Espresso/ })).toBeChecked();

    fireEvent.click(form.getByRole("button", { name: "Monday to Friday" }));
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
      expect(form.getByLabelText(day)).toBeChecked();
    }
    expect(form.getByLabelText("Saturday")).not.toBeChecked();
    fireEvent.click(form.getByRole("button", { name: "Every day" }));
    expect(form.getByLabelText("Sunday")).toBeChecked();
    fireEvent.click(form.getByRole("button", { name: "Saturday and Sunday" }));
    expect(form.getByLabelText("Monday")).not.toBeChecked();
  });

  it("marks the form unsaved when a preset picks the days, and asks before Start again replaces a draft", async () => {
    vi.stubGlobal("fetch", vi.fn((path: string) => Promise.resolve(respond(path === "/api/cafe" ? SETUP : { running: [], ended: [ENDED] }))));
    render(<CampaignsPage />);
    const form = within(await screen.findByRole("form", { name: "New campaign" }));
    expect(leavingAsks()).toBe(false);
    // A button, not an input event: still an unsaved change.
    fireEvent.click(form.getByRole("button", { name: "Every day" }));
    expect(leavingAsks()).toBe(true);
    fireEvent.input(form.getByLabelText("Name (English)"), { target: { value: "Rainy mornings" } });
    fireEvent.click(screen.getByRole("button", { name: "Start again Quiet afternoons" }));
    // The draft stays until the owner confirms.
    expect(form.getByLabelText("Name (English)")).toHaveValue("Rainy mornings");
    fireEvent.click(screen.getByRole("button", { name: "Yes, replace the draft with Quiet afternoons" }));
    const fresh = within(screen.getByRole("form", { name: "New campaign" }));
    expect(fresh.getByLabelText("Name (English)")).toHaveValue("Quiet afternoons");
    expect(leavingAsks()).toBe(false);
    // With nothing typed, Start again replaces the form at once.
    expect(screen.getByRole("button", { name: "Start again Quiet afternoons" })).toHaveTextContent(/^Start again$/);
  });
});

/** Whether leaving the page now would ask first. */
function leavingAsks(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
