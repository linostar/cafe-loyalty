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

export const reply =
  (status: number, json?: unknown): Handler =>
  (route) =>
    json === undefined ? route.fulfill({ status }) : route.fulfill({ status, json });

/** Member visits of four weeks, none unless `visits` gives them. */
export const visitHours = (visits: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))) => ({
  timeZone: "Asia/Beirut",
  from: "2026-09-11T08:00:00.000Z",
  to: "2026-10-09T08:00:00.000Z",
  visits,
});

/** What the home page's own requests get unless a test says otherwise: a café on its pilot plan, every wallet card update going through, no visits. */
const DEFAULTS: Readonly<Record<string, Handler>> = {
  "GET /api/cafe": reply(200, {
    cafe: { id: SESSION.cafe.id, name: SESSION.cafe.name, catalogVersion: 1, minMarginPercent: 0, winBack: { discount: null, cooldownDays: 30 }, googleReviewUrl: null, plan: "pilot" },
    program: null,
    orderTypes: [],
  }),
  "GET /api/cafe/wallet-deliveries": reply(200, { failing: [] }),
  "GET /api/cafe/visit-hours": reply(200, visitHours()),
};

/**
 * Answers the dashboard's API calls; anything not listed (or in DEFAULTS) gets a 404 envelope, so a missing mock
 * fails loudly.
 */
export async function mockApi(page: Page, listed: Readonly<Record<string, Handler>>): Promise<void> {
  const handlers = { ...DEFAULTS, ...listed };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const key = `${request.method()} ${new URL(request.url()).pathname}`;
    // Like the server: every write must carry a JSON body.
    if (request.method() !== "GET" && request.headers()["content-type"] !== "application/json") {
      await route.fulfill({ status: 415, json: { code: "UNSUPPORTED_MEDIA_TYPE", message: `${key} was sent without a JSON body.`, retryable: false } });
      return;
    }
    const handler = handlers[key];
    if (handler === undefined) {
      await route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: `No mock for ${key}.`, retryable: false } });
      return;
    }
    await handler(route);
  });
}
