import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EnvError, loadEnv } from "./env.js";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535),
  SECRET_KEY: z.string().min(32),
});

describe("loadEnv", () => {
  it("returns parsed and coerced values when valid", () => {
    const env = loadEnv(schema, { PORT: "3000", SECRET_KEY: "x".repeat(32) });
    expect(env).toEqual({ PORT: 3000, SECRET_KEY: "x".repeat(32) });
  });

  it("throws EnvError naming every invalid variable", () => {
    expect(() => loadEnv(schema, { PORT: "not-a-port" })).toThrow(EnvError);
    try {
      loadEnv(schema, { PORT: "not-a-port" });
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const keys = (error as EnvError).issues.map((issue) => issue.split(":")[0]);
      expect(keys).toEqual(["PORT", "SECRET_KEY"]);
    }
  });

  it("never echoes the offending value in the message", () => {
    const leaked = "short-secret-value";
    try {
      loadEnv(schema, { PORT: "3000", SECRET_KEY: leaked });
      expect.unreachable("loadEnv should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain(leaked);
    }
  });
});
