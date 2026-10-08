import { describe, expect, it } from "vitest";
import { EnvError } from "./env.js";
import { formatStartupFailure } from "./startup.js";

const now = new Date("2026-10-08T09:00:00.000Z");

describe("formatStartupFailure", () => {
  it("formats configuration errors with variable names only", () => {
    const line = formatStartupFailure(new EnvError(["PORT: Invalid input"]), "server", now);
    expect(JSON.parse(line)).toEqual({
      level: "fatal",
      time: "2026-10-08T09:00:00.000Z",
      service: "server",
      msg: "invalid configuration",
      issues: ["PORT: Invalid input"],
    });
  });

  it("serializes other errors with redaction", () => {
    const error = Object.assign(new Error("boom"), { token: "secret-token-value" });
    const record = JSON.parse(formatStartupFailure(error, "worker", now)) as Record<string, unknown>;
    expect(record).toMatchObject({ level: "fatal", service: "worker", msg: "startup failed" });
    expect(record.err).toMatchObject({ type: "Error", message: "boom", token: "[redacted]" });
    expect(JSON.stringify(record)).not.toContain("secret-token-value");
  });
});
