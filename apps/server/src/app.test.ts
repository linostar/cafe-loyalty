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
    expect(response?.json()).toEqual({ code: "NOT_FOUND", message: "No such page or API route.", retryable: false });

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
