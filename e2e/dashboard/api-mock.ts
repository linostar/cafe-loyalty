import type { Page, Route } from "@playwright/test";

export const SESSION = {
  owner: { id: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40", email: "rana@example.com" },
  cafe: { id: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", name: "Café Najjar" },
};

/** A test token shaped like the real ones (43 base64url characters); fake data only, never a real token. */
export const FAKE_TOKEN = "e2eFakeToken_0123456789abcdefghijklmnopqrst";
// The shape linkTokenSchema (packages/shared/src/owner-auth.ts) accepts, so the mocks match what the server takes.
if (!/^[A-Za-z0-9_-]{43}$/.test(FAKE_TOKEN)) {
  throw new Error("FAKE_TOKEN must have the shape the server accepts (linkTokenSchema).");
}

export const UNAUTHENTICATED = { code: "UNAUTHENTICATED", message: "Your session has ended. Sign in again.", retryable: false };

type Handler = (route: Route) => Promise<void>;

/** Answers the dashboard's API calls; anything not listed gets a 404 envelope, so a missing mock fails loudly. */
export async function mockApi(page: Page, handlers: Readonly<Record<string, Handler>>): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const key = `${request.method()} ${new URL(request.url()).pathname}`;
    const handler = handlers[key];
    if (handler === undefined) {
      await route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: `No mock for ${key}.`, retryable: false } });
      return;
    }
    await handler(route);
  });
}

export const reply =
  (status: number, json?: unknown): Handler =>
  (route) =>
    json === undefined ? route.fulfill({ status }) : route.fulfill({ status, json });
