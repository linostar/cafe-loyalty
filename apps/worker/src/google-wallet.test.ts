import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { googleLoyaltyClass, googleLoyaltyObject } from "@cafe-loyalty/db";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryError, deliveryErrorCode } from "./delivery.js";
import { createGoogleWallet } from "./google-wallet.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SERVICE_ACCOUNT = { email: "wallet@example-test.iam.gserviceaccount.com", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const ISSUER = "3388000000012345678";
const QR = "test-qr-token-that-must-never-be-logged";
const CLASS = googleLoyaltyClass(ISSUER, { id: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", name: "Café Najjar" }, "https://card.example.test/wallet/logo.png");
const OBJECT = googleLoyaltyObject(ISSUER, { cafeId: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", cardId: "6f1c1a52-7c55-4a0e-9a5e-0d4c1b2a3f40", epoch: 1, stamps: 2, program: undefined, qr: QR });

interface Seen {
  method: string;
  path: string;
  body: string;
  authorization: string | undefined;
}

type Answer = { status: number; body?: unknown } | "hang";

/** Google's token endpoint and Wallet API, answering each API request from `answers` in turn (200 when they run out). */
async function fakeGoogle(answers: Answer[] = []) {
  const seen: Seen[] = [];
  let tokens = 0;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const path = request.url ?? "";
      seen.push({ method: request.method ?? "", path, body, authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      if (path === "/token") {
        tokens += 1;
        response.end(JSON.stringify({ access_token: `token-${String(tokens)}`, expires_in: 3_600, token_type: "Bearer" }));
        return;
      }
      const answer = answers.shift() ?? { status: 200 };
      if (answer === "hang") {
        return;
      }
      response.statusCode = answer.status;
      response.end(JSON.stringify(answer.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const wallet = createGoogleWallet({ serviceAccount: SERVICE_ACCOUNT, apiOrigin: origin, tokenUrl: `${origin}/token`, timeoutMs: 500 });
  return { wallet, seen, api: () => seen.filter((request) => request.path !== "/token").map((request) => `${request.method} ${request.path}`), tokens: () => tokens };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

const objectPath = `/walletobjects/v1/loyaltyObject/${encodeURIComponent(OBJECT.id)}`;

describe("Google Wallet client", () => {
  it("signs in as the service account once and replaces the object with the whole of it", async () => {
    const google = await fakeGoogle();
    expect(await google.wallet.save(CLASS, OBJECT, true)).toBe("updated");
    expect(await google.wallet.save(CLASS, OBJECT, true)).toBe("updated");
    expect(google.tokens()).toBe(1);
    expect(google.api()).toEqual([`PUT ${objectPath}`, `PUT ${objectPath}`]);
    const put = google.seen.find((request) => request.method === "PUT");
    expect(put?.authorization).toBe("Bearer token-1");
    expect(JSON.parse(put?.body ?? "{}")).toEqual(OBJECT);
    // The sign-in assertion: RS256 by the service account, for the Wallet scope.
    const assertion = new URLSearchParams(google.seen.find((request) => request.path === "/token")?.body).get("assertion") ?? "";
    const [header = "", claims = "", signature = ""] = assertion.split(".");
    expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url")).toBe(true);
    expect(JSON.parse(Buffer.from(claims, "base64url").toString("utf8"))).toMatchObject({
      iss: SERVICE_ACCOUNT.email,
      scope: "https://www.googleapis.com/auth/wallet_object.issuer",
    });
  });

  it("creates a missing object, and its class unless that exists, only when asked to", async () => {
    const google = await fakeGoogle([{ status: 404 }, { status: 409 }, { status: 200 }, { status: 404 }]);
    expect(await google.wallet.save(CLASS, OBJECT, true)).toBe("created");
    expect(await google.wallet.save(CLASS, OBJECT, false)).toBe("missing");
    expect(google.api()).toEqual([`PUT ${objectPath}`, "POST /walletobjects/v1/loyaltyClass", "POST /walletobjects/v1/loyaltyObject", `PUT ${objectPath}`]);
  });

  it("updates an object the customer saved between its update and its insert", async () => {
    const google = await fakeGoogle([{ status: 404 }, { status: 200 }, { status: 409 }, { status: 200 }]);
    expect(await google.wallet.save(CLASS, OBJECT, true)).toBe("updated");
    expect(google.api()).toEqual([`PUT ${objectPath}`, "POST /walletobjects/v1/loyaltyClass", "POST /walletobjects/v1/loyaltyObject", `PUT ${objectPath}`]);
  });

  it("fails with Google's status as its code and none of the answer's text, and signs in again after a 401", async () => {
    const google = await fakeGoogle([
      { status: 503, body: { error: { code: 503, status: "UNAVAILABLE", message: `Backend error for barcode ${QR}` } } },
      { status: 401, body: { error: { status: "UNAUTHENTICATED" } } },
    ]);
    const failure = await google.wallet.save(CLASS, OBJECT, true).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeliveryError);
    expect(deliveryErrorCode(failure)).toBe("google_503_UNAVAILABLE");
    expect((failure as Error).message).not.toContain(QR);
    expect(deliveryErrorCode(await google.wallet.save(CLASS, OBJECT, true).catch((error: unknown) => error))).toBe("google_401_UNAUTHENTICATED");
    expect(await google.wallet.save(CLASS, OBJECT, true)).toBe("updated");
    expect(google.tokens()).toBe(2);
  });

  it("keeps the system code of a connection Google's address refuses", async () => {
    // A port nothing listens on any more: fetch rejects with "fetch failed", the system error as its cause.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${String((closed.address() as AddressInfo).port)}`;
    await new Promise((resolve) => closed.close(resolve));
    const wallet = createGoogleWallet({ serviceAccount: SERVICE_ACCOUNT, apiOrigin: origin, tokenUrl: `${origin}/token`, timeoutMs: 500 });
    expect(deliveryErrorCode(await wallet.save(CLASS, OBJECT, true).catch((error: unknown) => error))).toBe("ECONNREFUSED");
  });

  it("gives up on a request Google does not answer in time", async () => {
    const google = await fakeGoogle(["hang"]);
    expect(deliveryErrorCode(await google.wallet.save(CLASS, OBJECT, true).catch((error: unknown) => error))).toBe("timeout");
  });
});

describe("delivery error codes", () => {
  it("keeps a short code, a system error's code or the first of several, and nothing else", () => {
    expect(deliveryErrorCode(new DeliveryError("APNs answered 410.", "apns_410"))).toBe("apns_410");
    expect(deliveryErrorCode(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }))).toBe("ECONNREFUSED");
    expect(deliveryErrorCode(new AggregateError([new DeliveryError("APNs answered 503.", "apns_503"), new Error("x")]))).toBe("apns_503");
    // Anything else, which might carry text from elsewhere, is reduced to "error".
    expect(deliveryErrorCode(Object.assign(new Error("x"), { code: "has spaces and +961 70 123 456" }))).toBe("error");
    expect(deliveryErrorCode(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe("error");
    expect(deliveryErrorCode("a string")).toBe("error");
  });
});
