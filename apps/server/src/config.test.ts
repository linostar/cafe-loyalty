import { EnvError } from "@cafe-loyalty/shared";
import { describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";

const valid = { NODE_ENV: "test", HOST: "127.0.0.1", PORT: "3000", LOG_LEVEL: "info" };

describe("loadServerConfig", () => {
  it("parses a valid environment and applies the shutdown default", () => {
    expect(loadServerConfig(valid)).toEqual({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: 3000,
      LOG_LEVEL: "info",
      SHUTDOWN_TIMEOUT_MS: 10_000,
    });
  });

  it("rejects a missing HOST and an invalid PORT", () => {
    expect(() => loadServerConfig({ ...valid, HOST: undefined, PORT: "99999" })).toThrow(EnvError);
  });
});
