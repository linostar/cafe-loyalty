import { fireEvent, render, screen } from "@testing-library/react";
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

afterEach(() => {
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
        path === "/api/auth/login" ? respond(200, SESSION) : path === "/api/cafe/wallet-deliveries" ? respond(200, { failing: [] }) : unauthenticated(),
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
        Promise.resolve(path === "/api/auth/session" ? respond(200, SESSION) : path === "/api/cafe/wallet-deliveries" ? respond(200, { failing }) : unauthenticated()),
      ),
    );
    render(<App />);
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("Some customers' wallet cards are not updating");
    expect(warning).toHaveTextContent("Apple Wallet: 1 card, last failure");
    expect(warning).toHaveTextContent("apns_503_ServiceUnavailable");
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
