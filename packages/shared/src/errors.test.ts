import { describe, expect, it } from "vitest";
import {
  ApiError,
  ERROR_CODES,
  errorEnvelopeSchema,
  interpretErrorResponse,
  interpretNetworkFailure,
} from "./errors.js";

describe("ERROR_CODES", () => {
  it("uses client-error statuses for non-retryable codes except server failures", () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      if (spec.status >= 500 || code === "RATE_LIMITED") {
        expect(spec.retryable, code).toBe(true);
      } else {
        expect(spec.retryable, code).toBe(false);
      }
    }
  });
});

describe("ApiError", () => {
  it("builds a valid envelope with status and retryable from the code table", () => {
    const error = new ApiError("VALIDATION_FAILED", "The phone number is not valid.", [{ path: "phone", issue: "format" }]);
    expect(error.status).toBe(400);
    const envelope = error.toEnvelope();
    expect(errorEnvelopeSchema.parse(envelope)).toEqual({
      code: "VALIDATION_FAILED",
      message: "The phone number is not valid.",
      retryable: false,
      details: [{ path: "phone", issue: "format" }],
    });
  });

  it("omits details when there are none", () => {
    expect(new ApiError("NOT_FOUND", "No such card.").toEnvelope()).toEqual({
      code: "NOT_FOUND",
      message: "No such card.",
      retryable: false,
    });
  });
});

describe("interpretErrorResponse", () => {
  it("reads a valid envelope", () => {
    const body = JSON.stringify({ code: "RATE_LIMITED", message: "Too many requests.", retryable: true });
    expect(interpretErrorResponse(429, body)).toEqual({
      code: "RATE_LIMITED",
      message: "Too many requests.",
      retryable: true,
      status: 429,
    });
  });

  it("takes retryable from the code table, not from the response", () => {
    const body = JSON.stringify({ code: "SERVICE_UNAVAILABLE", message: "Down for maintenance.", retryable: false });
    expect(interpretErrorResponse(503, body)).toMatchObject({ code: "SERVICE_UNAVAILABLE", retryable: true });
  });

  it("still reads a known code when other fields have an unexpected shape", () => {
    const body = JSON.stringify({ code: "FORBIDDEN", message: "Owners only.", retryable: false, details: "not an array" });
    expect(interpretErrorResponse(403, body)).toEqual({ code: "FORBIDDEN", message: "Owners only.", retryable: false, status: 403 });
  });

  it("distinguishes an unreadable body from an unrecognised error", () => {
    expect(interpretErrorResponse(502, "<html></html>").message).toContain("unreadable");
    expect(interpretErrorResponse(400, JSON.stringify({ code: "NEW_CODE", message: "x" })).message).toContain("does not recognise");
  });

  it.each([
    ["an HTML proxy page", 502, "<html><body>Bad Gateway</body></html>"],
    ["an empty body", 503, ""],
    ["an unknown code", 400, JSON.stringify({ code: "FROM_A_NEWER_SERVER", message: "x", retryable: false })],
    ["JSON that is not an envelope", 500, JSON.stringify({ error: "boom" })],
    ["a null body", 502, "null"],
    ["a prototype key as code", 400, JSON.stringify({ code: "constructor", message: "x" })],
  ])("treats %s as retryable", (_label, status, body) => {
    const result = interpretErrorResponse(status, body);
    expect(result.code).toBeNull();
    expect(result.retryable).toBe(true);
    expect(result.status).toBe(status);
  });

  it("treats a network failure as retryable", () => {
    expect(interpretNetworkFailure()).toMatchObject({ code: null, retryable: true, status: null });
  });
});
