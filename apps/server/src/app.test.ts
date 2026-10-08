import { ApiError } from "@cafe-loyalty/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function capturingApp(): { lines: string[] } {
  const lines: string[] = [];
  app = buildApp({
    logLevel: "info",
    logDestination: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  });
  return { lines };
}

describe("GET /health/live", () => {
  it("returns 200 with status ok", async () => {
    app = buildApp({ logLevel: "silent" });
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("logging", () => {
  it("redacts sensitive fields in application logs at any depth", () => {
    const { lines } = capturingApp();
    app?.log.info({ phone: "+96170123456", body: { device: { pin: "123456" } } }, "stamp added");

    const line = lines.find((entry) => entry.includes("stamp added")) ?? "";
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.phone).toBe("[redacted]");
    expect(record.body).toEqual({ device: { pin: "[redacted]" } });
    expect(line).not.toContain("+96170123456");
  });

  it("logs request paths without query strings or headers", async () => {
    const { lines } = capturingApp();
    await app?.inject({
      method: "GET",
      url: "/health/live?qrToken=secret-qr-value",
      headers: { authorization: "Bearer secret-bearer", cookie: "sid=secret-cookie" },
    });

    const incoming = lines.find((entry) => entry.includes("incoming request")) ?? "";
    const record = JSON.parse(incoming) as { req?: Record<string, unknown> };
    expect(record.req).toMatchObject({ method: "GET", path: "/health/live" });
    for (const secret of ["secret-qr-value", "secret-bearer", "secret-cookie"]) {
      expect(lines.join("")).not.toContain(secret);
    }
  });

  it("masks secret-looking segments of unmatched paths", async () => {
    const { lines } = capturingApp();
    const response = await app?.inject({ method: "GET", url: "/card/AbCdEfGhIjKlMnOpQrStUv?x=1" });
    expect(response?.statusCode).toBe(404);
    expect(response?.json()).toEqual({ code: "NOT_FOUND", message: "No such page or API route. Check the address.", retryable: false });

    const incoming = lines.find((entry) => entry.includes("incoming request")) ?? "";
    const record = JSON.parse(incoming) as { req?: Record<string, unknown> };
    expect(record.req).toMatchObject({ path: "/card/[redacted]" });
    expect(lines.join("")).not.toContain("AbCdEfGhIjKlMnOpQrStUv");
  });

  it("logs errors with their type and stack and without sensitive fields", () => {
    const { lines } = capturingApp();
    app?.log.error({ err: Object.assign(new TypeError("bad input"), { detail: "Key (phone)=(+96170123456)" }) }, "failed");

    const line = lines.find((entry) => entry.includes('"failed"')) ?? "";
    const record = JSON.parse(line) as { err?: Record<string, unknown> };
    expect(record.err).toMatchObject({ type: "TypeError", message: "bad input", detail: "[redacted]" });
    expect(typeof record.err?.stack).toBe("string");
    expect(line).not.toContain("+96170123456");
  });
});

describe("error envelope", () => {
  function appWithRoutes(): FastifyInstance {
    const built = buildApp({ logLevel: "silent" });
    built.post("/echo", (request) => ({ received: request.body }));
    built.get("/conflict", () => {
      throw new ApiError("CONFLICT", "Already there.");
    });
    built.get("/crash", () => {
      throw new Error("database password=hunter2 rejected");
    });
    app = built;
    return built;
  }

  it("sends an ApiError with its status and envelope", async () => {
    const response = await appWithRoutes().inject({ method: "GET", url: "/conflict" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "CONFLICT", message: "Already there.", retryable: false });
  });

  it("hides unexpected errors behind INTERNAL", async () => {
    const response = await appWithRoutes().inject({ method: "GET", url: "/crash" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "INTERNAL", retryable: true });
    expect(response.body).not.toContain("hunter2");
  });

  it("wraps unparseable JSON as VALIDATION_FAILED", async () => {
    const response = await appWithRoutes().inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: '{"password": "hunter2"',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED", retryable: false });
    expect(response.body).not.toContain("hunter2");
  });

  it("refuses text/plain bodies, which a cross-site form could send", async () => {
    const response = await appWithRoutes().inject({ method: "POST", url: "/echo", headers: { "content-type": "text/plain" }, payload: "x" });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE", retryable: false });
  });

  it("wraps oversized bodies as PAYLOAD_TOO_LARGE", async () => {
    const response = await appWithRoutes().inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(1_100_000) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE", retryable: false });
  });

  it("does not log a rejected body", async () => {
    const { lines } = capturingApp();
    app?.post("/echo", () => ({}));
    await app?.inject({ method: "POST", url: "/echo", headers: { "content-type": "application/json" }, payload: '{"password": "hunter2"' });
    expect(lines.join("")).not.toContain("hunter2");
  });
});
