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

const unreachable = () => Promise.reject(new TypeError("Failed to fetch"));
const UNREACHABLE = "Could not reach the server. Check your connection and try again.";

/**
 * The API as Home sees it, with `setup` as the café's; writes to the setup milestones go through `writes`. `answer`
 * answers a request first when it returns a response (a failure, a held answer).
 */
function serve(
  initial: Setup,
  lists: { staff?: (typeof RAMI)[]; devices?: (typeof PHONE)[] } = {},
  answer: (method: string, path: string) => Promise<Response> | undefined = () => undefined,
) {
  let setup = initial;
  const writes: string[] = [];
  const fetch = vi.fn((path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const answered = answer(method, path);
    if (answered !== undefined) {
      return answered;
    }
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
  return { writes, gets: (path: string) => fetch.mock.calls.filter(([called, init]) => called === path && (init?.method ?? "GET") === "GET").length };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("setupProgress (D22)", () => {
  it("works each step out from the café's rows and the first print", () => {
    const fresh = { cafe: CAFE, program: null, orderTypes: [] };
    expect(setupProgress(fresh, [], [])).toEqual({ program: false, orderType: false, barista: false, phone: false, printed: false });
    // Only what still works counts: an order type off sale or earning no stamps, a removed barista or phone does not.
    expect(setupProgress({ ...fresh, orderTypes: [{ ...ESPRESSO, stampsEarned: 0 }] }, [], [])).toMatchObject({ orderType: false });
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

  it("asks before leaving a step whose form has unsaved edits, and keeps them on Cancel", async () => {
    serve({ cafe: CAFE, program: null, orderTypes: [] });
    render(<App />);
    await screen.findByRole("heading", { level: 2, name: "Set up your café" });
    const input = screen.getByRole("form", { name: "Loyalty program" }).querySelector("input");
    if (input === null) {
      throw new Error("The program form has no input");
    }
    fireEvent.input(input, { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    expect(screen.getByRole("heading", { level: 3, name: "Step 1 of 5 Your loyalty program" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(input).toHaveValue("8");
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, discard my changes" }));
    expect(screen.getByRole("heading", { level: 3, name: "Step 2 of 5 Your first order type" })).toBeInTheDocument();
    // The edits went with their step: the next one leaves without asking.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { level: 3, name: "Step 1 of 5 Your loyalty program" })).toBeInTheDocument();
  });

  it("keeps asking for a step's edits when Skip the rest fails", async () => {
    serve({ cafe: CAFE, program: null, orderTypes: [] }, {}, (method, path) => (method === "POST" && path === "/api/cafe/setup/finish" ? unreachable() : undefined));
    render(<App />);
    await screen.findByRole("heading", { level: 2, name: "Set up your café" });
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    const input = screen.getByRole("form", { name: "Add an order type" }).querySelector("input");
    if (input === null) {
      throw new Error("The order type form has no input");
    }
    fireEvent.input(input, { target: { value: "Espresso" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip the rest" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, discard my changes" }));
    expect(await screen.findByText(UNREACHABLE)).toBeInTheDocument();
    // Still on the step, with its edits: leaving it asks again.
    expect(input).toHaveValue("Espresso");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Yes, discard my changes" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Step 2 of 5 Your first order type" })).toBeInTheDocument();
  });

  it("loads the phones again when it leaves the phone step, for one paired there without Done", async () => {
    const { gets } = serve({ cafe: CAFE, program: null, orderTypes: [] });
    render(<App />);
    await screen.findByRole("heading", { level: 2, name: "Set up your café" });
    for (const label of ["Skip this step", "Skip this step", "Skip this step"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }
    expect(screen.getByRole("heading", { level: 3, name: "Step 4 of 5 Your counter phone" })).toBeInTheDocument();
    await waitFor(() => {
      expect(gets("/api/devices")).toBe(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    await waitFor(() => {
      expect(gets("/api/devices")).toBe(2);
    });
  });

  it("stays finished when a print is recorded only after Finish", async () => {
    const held: { answer?: (response: Response) => void } = {};
    const { writes } = serve({ cafe: CAFE, program: null, orderTypes: [] }, {}, (method, path) =>
      method === "POST" && path === "/api/cafe/join/printed" ? new Promise<Response>((resolve) => (held.answer = resolve)) : undefined,
    );
    render(<App />);
    await screen.findByRole("heading", { level: 2, name: "Set up your café" });
    for (const label of ["Skip this step", "Skip this step", "Skip this step", "Skip this step"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }
    await screen.findByRole("img", { name: "QR code customers scan to get a loyalty card" });
    vi.stubGlobal("print", () => window.dispatchEvent(new Event("beforeprint")));
    // Pressed again until the page listens for printing (an effect, which may run just after the code shows).
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "Print" }));
      expect(held.answer).toBeDefined();
    });
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Café Najjar" })).toBeInTheDocument();
    expect(writes).toEqual(["/api/cafe/setup/finish"]);
    // Answered with the setup from before Finish.
    held.answer?.(respond(200, { cafe: { ...CAFE, signupQrPrintedAt: PRINTED_AT }, program: null, orderTypes: [] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("heading", { level: 2, name: "Set up your café" })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Café Najjar" })).toBeInTheDocument();
  });
});

describe("Home's setup checklist (D22)", () => {
  it("is gone once every step is done, the staff and phones loaded (phones once, for Needs you too)", async () => {
    // The phones are answered only once the staff have been: Needs you's "Nothing needs you" (which waits for the
    // phones) then shows only after the checklist has both lists.
    let staffAnswered: () => void = () => undefined;
    const staff = new Promise<void>((resolve) => {
      staffAnswered = resolve;
    });
    const { gets } = serve({ cafe: { ...CAFE, setupFinishedAt: PRINTED_AT, signupQrPrintedAt: PRINTED_AT }, program: PROGRAM, orderTypes: [ESPRESSO] }, {}, (_method, path) => {
      if (path === "/api/staff") {
        setTimeout(staffAnswered, 0);
        return Promise.resolve(respond(200, { staff: [RAMI] }));
      }
      return path === "/api/devices"
        ? staff.then(() => new Promise((resolve) => setTimeout(resolve, 0))).then(() => respond(200, { devices: [{ ...PHONE, lastSeenAt: new Date().toISOString() }], pairingCodes: [] }))
        : undefined;
    });
    render(<App />);
    expect(await screen.findByRole("heading", { level: 2, name: "Café Najjar" })).toBeInTheDocument();
    expect(await screen.findByText("Nothing needs you right now.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Finish setting up" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Set up your café" })).toBeNull();
    expect(gets("/api/devices")).toBe(1);
  });

  it("offers Try again when the café's setup does not load, which brings a new café's wizard back", async () => {
    let failing = true;
    serve({ cafe: CAFE, program: null, orderTypes: [] }, {}, (_method, path) => (path === "/api/cafe" && failing ? unreachable() : undefined));
    render(<App />);
    expect(await screen.findByText(`Could not check your café's setup: ${UNREACHABLE}`)).toBeInTheDocument();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Set up your café" })).toBeInTheDocument();
  });
});

describe("the checklist's checks (D22)", () => {
  it("offers Try again when a list it needs does not load", async () => {
    let failing = true;
    serve({ cafe: { ...CAFE, setupFinishedAt: PRINTED_AT }, program: PROGRAM, orderTypes: [] }, {}, (_method, path) => (path === "/api/staff" && failing ? unreachable() : undefined));
    render(<App />);
    expect(await screen.findByText(`Could not check your setup: ${UNREACHABLE}`)).toBeInTheDocument();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Finish setting up" })).toHaveTextContent("1 of 5 done.");
  });
});

describe("the wizard's checks (D1)", () => {
  it("says when a step could not be checked, with Try again, rather than showing it as not done", async () => {
    let failing = true;
    serve({ cafe: CAFE, program: null, orderTypes: [] }, { staff: [RAMI] }, (_method, path) => (path === "/api/staff" && failing ? unreachable() : undefined));
    render(<App />);
    await screen.findByRole("heading", { level: 2, name: "Set up your café" });
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    const step = screen.getByRole("heading", { level: 3, name: "Step 3 of 5 Your first barista" }).parentElement;
    expect(await screen.findByRole("alert")).toHaveTextContent(`Could not check whether this step is done: ${UNREACHABLE}`);
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(step).toHaveTextContent("Done");
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when the first print could not be recorded", async () => {
    window.history.replaceState(null, "", "/cafe/print-qr");
    serve({ cafe: { ...CAFE, setupFinishedAt: PRINTED_AT }, program: null, orderTypes: [] }, {}, (method, path) =>
      method === "POST" && path === "/api/cafe/join/printed" ? unreachable() : undefined,
    );
    render(<App />);
    await screen.findByRole("img", { name: "QR code customers scan to get a loyalty card" });
    await waitFor(() => {
      window.dispatchEvent(new Event("beforeprint"));
      expect(screen.getByRole("alert")).toHaveTextContent(`Could not record this print for the setup checklist: ${UNREACHABLE}`);
    });
  });

  it("goes back to sign-in when the session ended before the print was recorded", async () => {
    window.history.replaceState(null, "", "/cafe/print-qr");
    serve({ cafe: { ...CAFE, setupFinishedAt: PRINTED_AT }, program: null, orderTypes: [] }, {}, (method, path) =>
      method === "POST" && path === "/api/cafe/join/printed"
        ? Promise.resolve(respond(401, { code: "UNAUTHENTICATED", message: "Your session has ended. Sign in again.", retryable: false }))
        : undefined,
    );
    render(<App />);
    await screen.findByRole("img", { name: "QR code customers scan to get a loyalty card" });
    await waitFor(() => {
      window.dispatchEvent(new Event("beforeprint"));
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Your session has ended. Sign in again.");
  });
});

describe("the print page (D6)", () => {
  it("shows the café's name and both languages' instructions whatever the page's, and records the first print once", async () => {
    window.history.replaceState(null, "", "/cafe/print-qr");
    const { writes } = serve({ cafe: { ...CAFE, setupFinishedAt: PRINTED_AT }, program: null, orderTypes: [] });
    render(<App />);
    expect(await screen.findByRole("heading", { level: 2, name: "Print the signup QR" })).toBeInTheDocument();
    await screen.findByRole("img", { name: "QR code customers scan to get a loyalty card" });
    // A sub-page of the Café page: its link, and More holding it, are marked current.
    const nav = screen.getByRole("navigation", { name: "Dashboard" });
    expect(within(nav).getByRole("link", { name: "Café" })).toHaveAttribute("aria-current", "true");
    expect(within(nav).getByRole("button", { name: "More" })).toHaveClass("is-current");
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
