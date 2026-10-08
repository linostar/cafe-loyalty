import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STAFF_PIN_ITERATIONS, hashPin } from "./pins.js";

describe("hashPin", () => {
  it("derives a 32-byte PBKDF2-SHA256 hash with a fresh 16-byte salt", async () => {
    const first = await hashPin("482913", 1_000);
    const second = await hashPin("482913", 1_000);
    expect(first.salt).toHaveLength(16);
    expect(first.hash).toHaveLength(32);
    expect(first.salt.equals(second.salt)).toBe(false);
    expect(first.hash.equals(pbkdf2Sync("482913", first.salt, 1_000, 32, "sha256"))).toBe(true);
  });

  it("uses OWASP's iteration count by default", async () => {
    expect(STAFF_PIN_ITERATIONS).toBe(600_000);
    expect((await hashPin("482913")).iterations).toBe(600_000);
  });
});
