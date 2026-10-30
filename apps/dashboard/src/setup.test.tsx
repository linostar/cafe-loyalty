import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { setupProgress } from "./setup.js";

const SESSION = {
  owner: { id: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40", email: "rana@example.com" },
  cafe: { id: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", name: "Café Najjar" },
};
const PRINTED_AT = "2026-10-20T09:00:00.000Z";
const CAFE = {
  id: SESSION.cafe.id,
  name: SESSION.cafe.name,
  catalogVersion: 1,
  minMarginPercent: 0,
  winBack: { discount: null, cooldownDays: 30 },
  googleReviewUrl: null,
  plan: "pilot" as const,
  setupFinishedAt: null as string | null,
  signupQrPrintedAt: null as string | null,
};
const PROGRAM = { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" };
const ESPRESSO = { id: "3d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f41", nameAr: "إسبريسو", nameEn: "Espresso", priceCents: 250, costCents: 70, stampsEarned: 1, active: true };
const RAMI = { id: "5d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f42", name: "Rami", revoked: false, createdAt: "2026-10-08T12:00:00.000Z" };
const PHONE = { id: "7d1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f43", name: "Front counter", pairedAt: PRINTED_AT, lastSeenAt: PRINTED_AT, revoked: false };

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Setup {
  cafe: typeof CAFE;
  program: typeof PROGRAM | null;
  orderTypes: (typeof ESPRESSO)[];
}

/** The API as Home sees it, with `setup` as the café's; writes to the setup milestones go through `writes`. */
function serve(initial: Setup, lists: { staff?: (typeof RAMI)[]; devices?: (typeof PHONE)[] } = {}) {
  let setup = initial;
  const writes: string[] = [];
  const fetch = vi.fn((path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && path === "/api/cafe/setup/finish") {
      writes.push(path);
      setup = { ...setup, cafe: { ...setup.cafe, setupFinishedAt: setup.cafe.setupFinishedAt ?? PRINTED_AT } };
      return Promise.resolve(respond(200, setup));
    }
    if (method === "POST" && path === "/api/cafe/join/printed") {
      writes.push(path);
      setup = { ...setup, cafe: { ...setup.cafe, signupQrPrintedAt: setup.cafe.signupQrPrintedAt ?? PRINTED_AT } };
      return Promise.resolve(respond(200, setup));
    }
    const answers: Record<string, unknown> = {
      "/api/auth/session": SESSION,
      "/api/cafe": setup,
      "/api/staff": { staff: lists.staff ?? [] },
      "/api/devices": { devices: lists.devices ?? [], pairingCodes: [] },
      "/api/cafe/join": { joinUrl: "https://card.example.test/join/0123456789abcdef0123456789abcdef" },
      "/api/cafe/wallet-deliveries": { failing: [] },
      "/api/review-queue": { items: [], nextCursor: null },
      "/api/feedback": { items: [], unread: 0, nextCursor: null },
    };
    return Promise.resolve(path in answers ? respond(200, answers[path]) : respond(404, { code: "NOT_FOUND", message: "No such page.", retryable: false }));
  });
  vi.stubGlobal("fetch", fetch);
  return { writes };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("setupProgress (D22)", () => {
  it("works each step out from the café's rows and the first print", () => {
    const fresh = { cafe: CAFE, program: null, orderTypes: [] };
    expect(setupProgress(fresh, [], [])).toEqual({ program: false, orderType: false, barista: false, phone: false, printed: false });
    // Only what still works counts: an order type off sale, a removed barista or phone does not.
    expect(setupProgress({ ...fresh, orderTypes: [{ ...ESPRESSO, active: false }] }, [{ ...RAMI, revoked: true }], [{ ...PHONE, revoked: true }])).toMatchObject({
      orderType: false,
      barista: false,
      phone: false,
    });
    expect(setupProgress({ cafe: { ...CAFE, signupQrPrintedAt: PRINTED_AT }, program: PROGRAM, orderTypes: [ESPRESSO] }, [RAMI], [PHONE])).toEqual({
      program: true,
      orderType: true,
      barista: true,
      phone: true,
      printed: true,
    });
  });
});

describe("the setup wizard (D1)", () => {
  it("goes step by step with focus on each step's heading, then records skipping the rest and shows Home's checklist", async () => {
    const { writes } = serve({ cafe: CAFE, program: PROGRAM, orderTypes: [] });
    render(<App />);
    expect(await screen.findByRole("heading", { level: 2, name: "Set up your café" })).toBeInTheDocument();
    const first = screen.getByRole("heading", { level: 3, name: "Step 1 of 5 Your loyalty program" });
    // The program is already saved: done, so the way on says Next.
    expect(first.parentElement).toHaveTextContent("Done");
    expect(screen.getByRole("form", { name: "Loyalty program" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { level: 3, name: "Step 2 of 5 Your first order type" })).toHaveFocus();
    expect(screen.getByRole("form", { name: "Add an order type" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    expect(screen.getByRole("heading", { level: 3, name: "Step 3 of 5 Your first barista" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { level: 3, name: "Step 2 of 5 Your first order type" })).toHaveFocus();
    expect(writes).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Skip the rest" }));
    const home = await screen.findByRole("heading", { level: 2, name: "Café Najjar" });
    expect(writes).toEqual(["/api/cafe/setup/finish"]);
    // Focus moves in an effect, which may run just after the heading shows.
    await waitFor(() => {
      expect(home).toHaveFocus();
    });
    const checklist = await screen.findByRole("region", { name: "Finish setting up" });
    expect(checklist).toHaveTextContent("1 of 5 done.");
    expect(within(checklist).getByRole("link", { name: "Add an order type" })).toHaveAttribute("href", "/cafe#menu");
    expect(within(checklist).getByRole("link", { name: "Print the QR" })).toHaveAttribute("href", "/cafe/print-qr");
    expect(within(checklist).queryByRole("link", { name: "Set the program" })).toBeNull();
  });

  it("records the first print from its last step, and finishing there", async () => {
    const { writes } = serve({ cafe: CAFE, program: null, orderTypes: [] });
    render(<App />);
    await screen.findByRole("heading", { level: 2, name: "Set up your café" });
    for (const label of ["Skip this step", "Skip this step", "Skip this step", "Skip this step"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }
    expect(screen.getByRole("heading", { level: 3, name: "Step 5 of 5 Your signup QR" })).toHaveFocus();
    expect(await screen.findByRole("img", { name: "QR code customers scan to get a loyalty card" })).toBeInTheDocument();
    const print = vi.fn(() => window.dispatchEvent(new Event("beforeprint")));
    vi.stubGlobal("print", print);
    // Pressed again until the page listens for printing (an effect, which may run just after the code shows).
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "Print" }));
      expect(writes).toEqual(["/api/cafe/join/printed"]);
    });
    expect(print).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 3, name: "Step 5 of 5 Your signup QR" }).parentElement).toHaveTextContent("Done");
    });
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Café Najjar" })).toBeInTheDocument();
    expect(writes).toEqual(["/api/cafe/join/printed", "/api/cafe/setup/finish"]);
  });
});

describe("Home's setup checklist (D22)", () => {
  it("is gone once every step is done", async () => {
    serve({ cafe: { ...CAFE, setupFinishedAt: PRINTED_AT, signupQrPrintedAt: PRINTED_AT }, program: PROGRAM, orderTypes: [ESPRESSO] }, { staff: [RAMI], devices: [PHONE] });
    render(<App />);
    expect(await screen.findByRole("heading", { level: 2, name: "Café Najjar" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Needs you" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Finish setting up" })).toBeNull();
    });
    expect(screen.queryByRole("heading", { name: "Set up your café" })).toBeNull();
  });
});

describe("the print page (D6)", () => {
  it("shows the café's name and both languages' instructions whatever the page's, and records the first print once", async () => {
    window.history.replaceState(null, "", "/cafe/print-qr");
    const { writes } = serve({ cafe: { ...CAFE, setupFinishedAt: PRINTED_AT }, program: null, orderTypes: [] });
    render(<App />);
    expect(await screen.findByRole("heading", { level: 2, name: "Print the signup QR" })).toBeInTheDocument();
    await screen.findByRole("img", { name: "QR code customers scan to get a loyalty card" });
    const sheet = document.querySelector(".print-sheet");
    expect(sheet).toHaveTextContent("Café Najjar");
    expect(sheet?.querySelector('[lang="ar"]')).toHaveTextContent("احصل على بطاقة الولاء");
    expect(sheet?.querySelector('[lang="en"]')).toHaveTextContent("Get your loyalty card");
    // Printed again and again (the browser's own command too) until the page listens: recorded once all the same.
    await waitFor(() => {
      window.dispatchEvent(new Event("beforeprint"));
      expect(writes).toEqual(["/api/cafe/join/printed"]);
    });
    window.dispatchEvent(new Event("beforeprint"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writes).toEqual(["/api/cafe/join/printed"]);
  });
});
