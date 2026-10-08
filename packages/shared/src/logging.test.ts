import { describe, expect, it } from "vitest";
import { LOG_REDACT_CENSOR, isSensitiveKey, redactLogObject } from "./logging.js";

const R = LOG_REDACT_CENSOR;

describe("isSensitiveKey", () => {
  it.each([
    "phone",
    "phoneNumber",
    "customerEmail",
    "Email",
    "pin",
    "pinHash",
    "staff_pin",
    "password",
    "token",
    "accessToken",
    "refresh_token",
    "pushToken",
    "qrToken",
    "authenticationToken",
    "secret",
    "apiKey",
    "api_key",
    "authorization",
    "cookie",
    "set-cookie",
    "otp",
    "jwt",
    "detail",
    "phonePepper",
  ])("treats %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["cafeId", "deviceId", "mapping", "footprint", "spinner", "shipping", "status", "task", "msg", "level"])(
    "keeps %s",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe("redactLogObject", () => {
  it("redacts at any depth and inside arrays", () => {
    const input = {
      cafeId: "c1",
      body: { customer: { email: "a@example.com", name: "Rana" } },
      customers: [{ phone: "+96170123456" }, { phoneNumber: "+96171000000" }],
    };
    expect(redactLogObject(input)).toEqual({
      cafeId: "c1",
      body: { customer: { email: R, name: "Rana" } },
      customers: [{ phone: R }, { phoneNumber: R }],
    });
  });

  it("redacts a raw headers object", () => {
    const input = { headers: { authorization: "Bearer A1", cookie: "sid=C1", "set-cookie": ["sid=C2"], host: "x" } };
    expect(redactLogObject(input)).toEqual({
      headers: { authorization: R, cookie: R, "set-cookie": R, host: "x" },
    });
  });

  it("serializes errors and redacts their extra fields and causes", () => {
    const cause = Object.assign(new Error("inner"), { email: "a@example.com" });
    const error = Object.assign(new Error("duplicate key", { cause }), {
      code: "23505",
      detail: "Key (phone)=(+96170123456) already exists.",
    });
    const output = redactLogObject({ err: error });
    expect(output.err).toMatchObject({
      type: "Error",
      message: "duplicate key",
      code: "23505",
      detail: R,
      cause: { type: "Error", message: "inner", email: R },
    });
    expect(JSON.stringify(output)).not.toContain("+96170123456");
    expect(JSON.stringify(output)).not.toContain("a@example.com");
  });

  it("serializes aggregate errors with their inner errors", () => {
    const error = new AggregateError([Object.assign(new Error("a"), { token: "t1" })], "many");
    expect(redactLogObject({ err: error }).err).toMatchObject({
      type: "AggregateError",
      message: "many",
      errors: [{ type: "Error", message: "a", token: R }],
    });
  });

  it("does not mutate the input", () => {
    const input = { nested: { phone: "+96170123456" } };
    redactLogObject(input);
    expect(input.nested.phone).toBe("+96170123456");
  });

  it("marks circular references instead of recursing forever", () => {
    const input: Record<string, unknown> = { name: "loop" };
    input.self = input;
    expect(redactLogObject(input)).toEqual({ name: "loop", self: "[circular]" });
  });

  it("passes class instances through for pino's serializers", () => {
    class Request {
      readonly url = "/x";
    }
    const request = new Request();
    expect(redactLogObject({ req: request }).req).toBe(request);
  });

  it("truncates beyond the maximum depth", () => {
    let deep: Record<string, unknown> = { value: "bottom" };
    for (let level = 0; level < 12; level += 1) {
      deep = { next: deep };
    }
    expect(JSON.stringify(redactLogObject(deep))).toContain("[truncated]");
  });
});
