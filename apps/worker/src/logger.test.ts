import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

function capture(): { lines: string[]; write(chunk: string): void } {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
    },
  };
}

describe("createLogger", () => {
  it("redacts sensitive fields at any depth and keeps the rest", () => {
    const sink = capture();
    const logger = createLogger("info", sink);
    logger.info(
      { phone: "+96170123456", job: { customer: { email: "a@example.com" }, pins: [{ pin: "123456" }] }, cafeId: "c1" },
      "event",
    );

    expect(sink.lines).toHaveLength(1);
    const line = sink.lines[0] ?? "";
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.phone).toBe("[redacted]");
    expect(record.job).toEqual({ customer: { email: "[redacted]" }, pins: [{ pin: "[redacted]" }] });
    expect(record.cafeId).toBe("c1");
    expect(record.msg).toBe("event");
    expect(line).not.toContain("+96170123456");
    expect(line).not.toContain("a@example.com");
    expect(line).not.toContain("123456");
  });

  it("logs errors with their stack and without sensitive fields", () => {
    const sink = capture();
    const logger = createLogger("info", sink);
    logger.error({ err: Object.assign(new Error("duplicate key"), { detail: "Key (phone)=(+96170123456)" }) }, "failed");

    const record = JSON.parse(sink.lines[0] ?? "{}") as { err?: Record<string, unknown> };
    expect(record.err).toMatchObject({ type: "Error", message: "duplicate key", detail: "[redacted]" });
    expect(typeof record.err?.stack).toBe("string");
    expect(sink.lines[0]).not.toContain("+96170123456");
  });
});
